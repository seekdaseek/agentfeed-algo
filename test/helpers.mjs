import { createHash } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Build a genuinely valid Algorand address from a fixed public key.
 * Deterministic, so tests are stable, and correct by construction rather than
 * by a string somebody typed once and nobody rechecked.
 */
export function makeAddress(seed = 7) {
  const pk = Buffer.alloc(32, seed);
  const checksum = createHash('sha512-256').update(pk).digest().subarray(-4);
  return base32Encode(Buffer.concat([pk, checksum])).slice(0, 58);
}

export const VALID_ADDRESS = makeAddress(7);
export const OTHER_ADDRESS = makeAddress(9);

/**
 * A tape store backed by an array, matching the real schema exactly:
 * ts in milliseconds, symbol as an exchange pair, side of Sell or Buy,
 * usd, and exchange.
 *
 * The matcher below answers the five query shapes tape.mjs issues. It is
 * deliberately literal rather than a general SQL engine, so a query that
 * changes shape fails loudly here instead of quietly returning nothing.
 */
export class FakeTapeStore {
  constructor(rowsIn = []) {
    this.rows = rowsIn;
    this.failure = null;
    this.calls = [];
  }

  failWith(message) {
    this.failure = message;
    return this;
  }

  query(sql, params = []) {
    this.calls.push({ sql, params });
    if (this.failure) return { rows: null, failure: this.failure };

    // 1. symbol resolution
    if (sql.startsWith('SELECT symbol FROM liquidations WHERE symbol IN')) {
      const known = new Set(this.rows.map((r) => r.symbol));
      return { rows: params.filter((p) => known.has(p)).map((symbol) => ({ symbol })), failure: null };
    }

    // 2. window, grouped by exchange and side
    if (sql.includes('GROUP BY exchange, side')) {
      const [symbol, since] = params;
      const hit = this.rows.filter((r) => r.symbol === symbol && r.ts >= since);
      const grouped = new Map();
      for (const r of hit) {
        const key = `${r.exchange}|${r.side}`;
        const cur = grouped.get(key) ?? { exchange: r.exchange, side: r.side, n: 0, usd: 0 };
        cur.n += 1;
        cur.usd += r.usd;
        grouped.set(key, cur);
      }
      return { rows: [...grouped.values()], failure: null };
    }

    // 3. cascade, raw rows in order
    if (sql.startsWith('SELECT ts, usd, side')) {
      const [symbol, since] = params;
      return {
        rows: this.rows
          .filter((r) => r.symbol === symbol && r.ts >= since)
          .sort((a, b) => a.ts - b.ts)
          .map((r) => ({ ts: r.ts, usd: r.usd, side: r.side })),
        failure: null,
      };
    }

    // 4. universe, grouped by symbol
    if (sql.includes('GROUP BY symbol ORDER BY n DESC')) {
      const [since] = params;
      const bySym = new Map();
      for (const r of this.rows.filter((x) => x.ts >= since)) {
        bySym.set(r.symbol, (bySym.get(r.symbol) ?? 0) + 1);
      }
      return {
        rows: [...bySym.entries()].map(([symbol, n]) => ({ symbol, n })).sort((a, b) => b.n - a.n),
        failure: null,
      };
    }

    // 5. exchange integrity
    if (sql.includes('COUNT(DISTINCT symbol)')) {
      const [since] = params;
      const byEx = new Map();
      for (const r of this.rows.filter((x) => x.ts >= since)) {
        const cur = byEx.get(r.exchange) ?? { exchange: r.exchange, n: 0, syms: new Set() };
        cur.n += 1;
        cur.syms.add(r.symbol);
        byEx.set(r.exchange, cur);
      }
      return {
        rows: [...byEx.values()].map((v) => ({ exchange: v.exchange, n: v.n, syms: v.syms.size })),
        failure: null,
      };
    }

    throw new Error(`FakeTapeStore saw an unrecognised query shape: ${sql.slice(0, 90)}`);
  }
}

export const NOW = 1_754_400_000_000;

/** Rows shaped exactly like the production tape. Sell liquidates a short, Buy a long. */
export function rows() {
  return [
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: NOW - 30_000, usd: 1000 },
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Sell', ts: NOW - 40_000, usd: 2000 },
    { symbol: 'SOLUSDT', exchange: 'binance', side: 'Buy', ts: NOW - 50_000, usd: 500 },
    { symbol: 'BTCUSDT', exchange: 'okx', side: 'Sell', ts: NOW - 60_000, usd: 9000 },
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: NOW - 10 * 3600_000, usd: 250 },
  ];
}

export function baseEnv(over = {}) {
  return {
    ALGO_NETWORK: 'testnet',
    ALGO_PAY_TO: VALID_ADDRESS,
    PUBLIC_BASE_URL: 'http://localhost:3010',
    PORT: '3010',
    LEDGER_PATH: '/tmp/agentfeed-test-ledger.jsonl',
    ...over,
  };
}

/** A facilitator that answers however the test wants. */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

export function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
