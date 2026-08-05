/**
 * The settlement ledger.
 *
 * The Global x402 Challenge asks entrants to submit "what the payment unlocks
 * and proof of who is paying for it". The facilitator leaderboard is one half
 * of that. This is the other half, on our side of the wire: an append only
 * record of every verify and every settle, successful or not.
 *
 * It exists because a leaderboard tells you a total and nothing else. It cannot
 * tell you whether ten agents each paid twenty times or one agent paid two
 * hundred, and those are completely different businesses. Concentration is the
 * first thing an honest reader of usage numbers should want to know, so it is
 * computed here rather than left as an exercise.
 *
 * Nothing is ever revised. If a later reading disagrees with an earlier one,
 * both lines stay.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const SCHEMA = 'agentfeed.settlement/v1';

export const EVENT = Object.freeze({
  VERIFIED: 'verified',
  VERIFY_FAILED: 'verify_failed',
  SETTLED: 'settled',
  SETTLE_FAILED: 'settle_failed',
  CANCELED: 'canceled',
});

const SECRET_KEY = /^(authorization|api[-_]?key|secret|token|mnemonic|private[-_]?key)$/i;

/** Strip anything secret shaped before a line can reach disk. */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string' && /^Bearer\s+\S+/i.test(value)) return '[redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export function buildEntry({
  event,
  routeId = null,
  path = null,
  payer = null,
  amountMicro = null,
  asset = null,
  network = null,
  txId = null,
  reason = null,
  now = Date.now,
}) {
  if (!Object.values(EVENT).includes(event)) throw new TypeError(`unknown ledger event "${event}"`);
  return redact({
    schema: SCHEMA,
    ts: new Date(now()).toISOString(),
    event,
    routeId,
    path,
    payer,
    amountMicro: amountMicro === null ? null : String(amountMicro),
    asset,
    network,
    txId,
    reason,
  });
}

export class Ledger {
  constructor(path, { now = Date.now } = {}) {
    this.path = path;
    this.now = now;
  }

  async record(fields) {
    const entry = buildEntry({ ...fields, now: this.now });
    try {
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // A ledger write must never take down a paid request. The facilitator is
      // the authoritative record; this is our copy of it.
    }
    return entry;
  }

  async all() {
    if (!existsSync(this.path)) return [];
    const text = await readFile(this.path, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          return { schema: 'agentfeed.settlement/corrupt', line: i + 1 };
        }
      });
  }

  /**
   * Usage summary, with concentration stated up front.
   *
   * The headline that matters is not the total. It is how much of the total came
   * from the single largest payer, because a number that is 90 percent one
   * wallet is a very different claim from the same number spread over thirty.
   */
  async summary() {
    const rows = await this.all();
    const settled = rows.filter((r) => r.event === EVENT.SETTLED);

    const byPayer = new Map();
    const byRoute = new Map();
    let totalMicro = 0n;

    for (const r of settled) {
      const amt = r.amountMicro ? BigInt(r.amountMicro) : 0n;
      totalMicro += amt;
      if (r.payer) byPayer.set(r.payer, (byPayer.get(r.payer) ?? 0n) + amt);
      if (r.routeId) byRoute.set(r.routeId, (byRoute.get(r.routeId) ?? 0n) + amt);
    }

    const payers = [...byPayer.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1));
    const topShare =
      totalMicro > 0n && payers.length > 0
        ? Number((payers[0][1] * 10000n) / totalMicro) / 100
        : 0;

    return {
      events: rows.length,
      settlements: settled.length,
      verifyFailures: rows.filter((r) => r.event === EVENT.VERIFY_FAILED).length,
      settleFailures: rows.filter((r) => r.event === EVENT.SETTLE_FAILED).length,
      distinctPayers: byPayer.size,
      totalMicro: totalMicro.toString(),
      largestPayerSharePct: topShare,
      byRoute: Object.fromEntries([...byRoute].map(([k, v]) => [k, v.toString()])),
      concentrationNote:
        byPayer.size === 0
          ? 'no settlements recorded yet'
          : `${topShare}% of settled value came from the single largest payer across ${byPayer.size} distinct payer(s)`,
    };
  }
}
