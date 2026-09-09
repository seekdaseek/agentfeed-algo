/**
 * The tape.
 *
 * Written against the real schema:
 *
 *   liquidations(id, ts INTEGER ms, symbol TEXT, side TEXT, size REAL,
 *                price REAL, usd REAL, exchange TEXT DEFAULT 'bybit')
 *   indexes on (symbol, ts), (exchange, ts), (ts)
 *
 * Three things about that schema shape this file.
 *
 * The column is `exchange`, not venue.
 *
 * Symbols are exchange pairs, SOLUSDT rather than SOL. That matters more than
 * it looks. If a caller asks for SOL and we query for SOL, we get zero rows,
 * and the naive answer is "no liquidations for SOL in this window". That is a
 * finding, and it is false. The truth is that we never had a symbol by that
 * name. A coverage gap reported as a market fact is the exact failure this
 * service exists to avoid, so symbol resolution happens first and a symbol we
 * do not carry comes back UNMEASURED, not absent, and is therefore not billed.
 *
 * And `side` is free signal we would otherwise have thrown away. Sell means a
 * short was liquidated, Buy means a long was. Whether a move flushed longs or
 * shorts is most of what a reader actually wants, so every window carries it.
 */

import { measured, absent, unmeasured } from './envelope.mjs';

const SOURCE = 'agentfeed liquidation tape';
const BASIS = 'forced liquidations reported by Binance, Bybit and OKX';

/** Quote assets tried when resolving a bare symbol like SOL to a traded pair. */
export const QUOTE_SUFFIXES = Object.freeze(['USDT', 'USD', 'USDC']);

/**
 * Per exchange reporting integrity, stated because it changes how the numbers
 * should be read. Binance and OKX emit at most one update per symbol per
 * second, which undercounts exactly when it matters most, during a cascade.
 * Bybit does not.
 */
export const EXCHANGE_NOTES = Object.freeze({
  binance: 'one update per symbol per second, so undercounts during cascades',
  okx: 'one update per symbol per second, so undercounts during cascades',
  bybit: 'complete unthrottled stream, the high integrity portion of the tape',
});

/** side to what was liquidated. Taken from the schema comment, not guessed. */
export const SIDE_MEANING = Object.freeze({ Sell: 'shorts', Buy: 'longs' });

export class SqliteTapeStore {
  constructor(path, { DatabaseSync } = {}) {
    this.path = path;
    this.DatabaseSync = DatabaseSync;
    this.db = null;
    this.openError = null;
  }

  open() {
    if (this.db || this.openError) return;
    try {
      const Ctor = this.DatabaseSync;
      if (!Ctor) throw new Error('no sqlite driver supplied');
      this.db = new Ctor(this.path, { readOnly: true });
    } catch (err) {
      this.openError = err?.message ?? String(err);
    }
  }

  query(sql, params = []) {
    this.open();
    if (this.openError) return { rows: null, failure: `tape unavailable: ${this.openError}` };
    try {
      return { rows: this.db.prepare(sql).all(...params), failure: null };
    } catch (err) {
      return { rows: null, failure: `tape query failed: ${err?.message ?? String(err)}` };
    }
  }
}

/** A store that always fails, used when no tape is configured. Honest by construction. */
export class MissingTapeStore {
  query() {
    return { rows: null, failure: 'no tape configured on this deployment' };
  }
}

/**
 * Resolve a caller's symbol to one the tape actually carries.
 *
 * Returns { symbol, matched, candidates, failure, malformed }. `matched` is
 * 'exact' when the caller named a real pair, 'suffixed' when a quote asset was
 * appended for them, and null when this tape does not carry the symbol at all.
 * That last case is a coverage answer and never a market answer.
 */
export function resolveSymbol(store, input) {
  const raw = typeof input === 'string' ? input.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{2,20}$/.test(raw)) {
    return { symbol: null, matched: null, candidates: [], failure: null, malformed: true };
  }

  const candidates = [raw, ...QUOTE_SUFFIXES.map((q) => `${raw}${q}`)];
  const placeholders = candidates.map(() => '?').join(', ');
  const { rows, failure } = store.query(
    `SELECT symbol FROM liquidations WHERE symbol IN (${placeholders}) GROUP BY symbol`,
    candidates,
  );
  if (failure) return { symbol: null, matched: null, candidates, failure, malformed: false };

  const known = new Set(rows.map((r) => r.symbol));
  if (known.has(raw)) return { symbol: raw, matched: 'exact', candidates, failure: null, malformed: false };
  for (const q of QUOTE_SUFFIXES) {
    if (known.has(`${raw}${q}`)) {
      return { symbol: `${raw}${q}`, matched: 'suffixed', candidates, failure: null, malformed: false };
    }
  }
  return { symbol: null, matched: null, candidates, failure: null, malformed: false };
}

/** Turn a resolution miss into the right envelope, never into a market claim. */
function resolutionEnvelope(res, input) {
  if (res.malformed) {
    return unmeasured({ source: SOURCE, basis: 'symbol parameter missing or malformed' });
  }
  if (res.failure) {
    return unmeasured({ source: SOURCE, basis: BASIS, failure: { reason: res.failure } });
  }
  return unmeasured({
    source: SOURCE,
    basis:
      `this tape does not carry a symbol matching "${input}"; tried ${res.candidates.join(', ')}. ` +
      'That is a coverage gap on our side, not a statement that the market was quiet.',
    failure: { reason: 'symbol_not_covered' },
  });
}

function clampHours(hours) {
  const h = Number(hours);
  return Number.isInteger(h) && h >= 1 && h <= 168 ? h : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pickExchangeNotes(list) {
  const out = {};
  for (const v of list) {
    const key = String(v).toLowerCase();
    if (EXCHANGE_NOTES[key]) out[key] = EXCHANGE_NOTES[key];
  }
  return out;
}

export function liquidationWindow(store, { symbol, hours = 24, now = Date.now() }) {
  const h = clampHours(hours);
  if (h === null) return unmeasured({ source: SOURCE, basis: 'hours must be between 1 and 168' });

  const res = resolveSymbol(store, symbol);
  if (!res.symbol) return resolutionEnvelope(res, symbol);

  const since = now - h * 3600_000;
  const { rows, failure } = store.query(
    'SELECT exchange, side, COUNT(*) AS n, SUM(usd) AS usd FROM liquidations WHERE symbol = ? AND ts >= ? GROUP BY exchange, side',
    [res.symbol, since],
  );
  if (failure) return unmeasured({ source: SOURCE, basis: BASIS, failure: { reason: failure } });

  if (!rows.length) {
    // The symbol is carried and the window is empty. This one really is a quiet
    // market, and it is a finding a buyer can use.
    return absent({
      asOf: now,
      source: SOURCE,
      basis: `${BASIS}; ${res.symbol} is covered by this tape and had no liquidations in the last ${h}h`,
    });
  }

  const byExchangeRaw = {};
  const bySide = { longs: 0, shorts: 0 };
  const unknownSides = new Set();
  let totalUsd = 0;
  let totalRows = 0;
  let otherUsd = 0;

  for (const r of rows) {
    const usd = Number(r.usd);
    const n = Number(r.n);
    if (!Number.isFinite(usd) || !Number.isFinite(n)) continue;
    const ex = String(r.exchange);
    byExchangeRaw[ex] = byExchangeRaw[ex] ?? { rows: 0, usd: 0 };
    byExchangeRaw[ex].rows += n;
    byExchangeRaw[ex].usd += usd;
    const liquidated = SIDE_MEANING[r.side];
    if (liquidated) {
      bySide[liquidated] += usd;
    } else {
      // A side value the schema did not describe. It must not disappear into
      // the gap between the total and the split, so it gets its own line and
      // the value that produced it is named.
      otherUsd += usd;
      unknownSides.add(String(r.side));
    }
    totalUsd += usd;
    totalRows += n;
  }

  const byExchange = Object.fromEntries(
    Object.entries(byExchangeRaw).map(([k, v]) => [k, { rows: v.rows, usd: round2(v.usd) }]),
  );

  return measured(
    {
      symbol: res.symbol,
      requested: symbol,
      hours: h,
      total_usd: round2(totalUsd),
      rows: totalRows,
      longs_usd: round2(bySide.longs),
      shorts_usd: round2(bySide.shorts),
      other_usd: round2(otherUsd),
      by_exchange: byExchange,
    },
    {
      asOf: now,
      source: SOURCE,
      basis: BASIS,
      control: {
        symbol_resolution: res.matched,
        side_convention:
          'Sell liquidates a short, Buy liquidates a long; the split is by what was liquidated',
        reconciliation:
          'longs_usd + shorts_usd + other_usd equals total_usd before rounding; each field is rounded to the cent independently, so the visible sum can differ from total_usd by up to a cent',
        unclassified_sides: unknownSides.size ? [...unknownSides] : undefined,
        exchange_reporting: pickExchangeNotes(Object.keys(byExchange)),
        caveat: 'exchange totals are not directly comparable; see exchange_reporting',
      },
    },
  );
}

export function liquidationCascade(store, { symbol, minutes = 60, now = Date.now() }) {
  const m = Number(minutes);
  if (!Number.isInteger(m) || m < 5 || m > 240) {
    return unmeasured({ source: SOURCE, basis: 'minutes must be an integer between 5 and 240' });
  }

  const res = resolveSymbol(store, symbol);
  if (!res.symbol) return resolutionEnvelope(res, symbol);

  const since = now - m * 60_000;
  const { rows, failure } = store.query(
    'SELECT ts, usd, side FROM liquidations WHERE symbol = ? AND ts >= ? ORDER BY ts',
    [res.symbol, since],
  );
  if (failure) return unmeasured({ source: SOURCE, basis: BASIS, failure: { reason: failure } });
  if (!rows.length) {
    return absent({
      asOf: now,
      source: SOURCE,
      basis: `${res.symbol} is covered and had no liquidations in the last ${m}m`,
    });
  }

  // A cascade is clustering, not volume. Ten million spread evenly over an hour
  // is a different event from ten million inside ninety seconds, and only the
  // second one moves a book. The score is the share of the window's value that
  // landed in its busiest single minute.
  const buckets = new Map();
  const bySide = { longs: 0, shorts: 0 };
  let total = 0;
  let otherUsd = 0;
  for (const r of rows) {
    const usd = Number(r.usd);
    if (!Number.isFinite(usd)) continue;
    const bucket = Math.floor(Number(r.ts) / 60_000);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + usd);
    const liquidated = SIDE_MEANING[r.side];
    if (liquidated) bySide[liquidated] += usd;
    else otherUsd += usd;
    total += usd;
  }
  if (total <= 0 || buckets.size === 0) {
    return absent({ asOf: now, source: SOURCE, basis: `no positive liquidation value for ${res.symbol}` });
  }

  const peak = Math.max(...buckets.values());

  return measured(
    {
      symbol: res.symbol,
      requested: symbol,
      minutes: m,
      total_usd: round2(total),
      peak_minute_usd: round2(peak),
      concentration: Number((peak / total).toFixed(4)),
      active_minutes: buckets.size,
      events: rows.length,
      longs_usd: round2(bySide.longs),
      shorts_usd: round2(bySide.shorts),
      other_usd: round2(otherUsd),
      dominant_side:
        bySide.longs === bySide.shorts ? 'balanced' : bySide.longs > bySide.shorts ? 'longs' : 'shorts',
    },
    {
      asOf: now,
      source: SOURCE,
      basis: `${BASIS}; concentration is the share of window value in its busiest minute`,
      control: {
        symbol_resolution: res.matched,
        interpretation:
          'concentration near 1 means the window was a single burst; near 1/active_minutes means it was evenly spread',
        floor: Number((1 / buckets.size).toFixed(4)),
        side_convention: 'Sell liquidates a short, Buy liquidates a long',
      },
    },
  );
}

export function liquidationUniverse(store, { hours = 24, now = Date.now() }) {
  const h = clampHours(hours);
  if (h === null) return unmeasured({ source: SOURCE, basis: 'hours must be between 1 and 168' });

  const since = now - h * 3600_000;
  const { rows, failure } = store.query(
    'SELECT symbol, COUNT(*) AS n FROM liquidations WHERE ts >= ? GROUP BY symbol ORDER BY n DESC',
    [since],
  );
  if (failure) return unmeasured({ source: SOURCE, basis: BASIS, failure: { reason: failure } });
  if (!rows.length) {
    return absent({ asOf: now, source: SOURCE, basis: `no liquidations recorded in the last ${h}h` });
  }

  return measured(
    {
      hours: h,
      symbols: rows.length,
      rows: rows.reduce((a, r) => a + Number(r.n), 0),
      top: rows.slice(0, 25).map((r) => ({ symbol: r.symbol, rows: Number(r.n) })),
    },
    {
      asOf: now,
      source: SOURCE,
      basis: `${BASIS}; symbols are exchange pairs such as SOLUSDT, and coverage is what the tape saw, not what exists`,
    },
  );
}

export function venueIntegrity(store, { hours = 24, now = Date.now() }) {
  const h = clampHours(hours);
  if (h === null) return unmeasured({ source: SOURCE, basis: 'hours must be between 1 and 168' });

  const since = now - h * 3600_000;
  const { rows, failure } = store.query(
    'SELECT exchange, COUNT(*) AS n, COUNT(DISTINCT symbol) AS syms FROM liquidations WHERE ts >= ? GROUP BY exchange',
    [since],
  );
  if (failure) return unmeasured({ source: SOURCE, basis: BASIS, failure: { reason: failure } });
  if (!rows.length) {
    return absent({ asOf: now, source: SOURCE, basis: `no exchange activity in the last ${h}h` });
  }

  return measured(
    {
      hours: h,
      exchanges: rows.map((r) => ({
        exchange: r.exchange,
        rows: Number(r.n),
        symbols: Number(r.syms),
        reporting:
          EXCHANGE_NOTES[String(r.exchange).toLowerCase()] ?? 'reporting behaviour not characterised',
      })),
    },
    {
      asOf: now,
      source: SOURCE,
      basis: 'per exchange row and symbol counts for the window',
      control: {
        why_this_matters:
          'two exchanges throttle to one update per symbol per second, so their counts understate cascades; comparing raw totals across exchanges without this is a mistake',
      },
    },
  );
}

/**
 * Bucket widths in milliseconds. Two only, and both chosen so the whole
 * recorded span fits in one response: hourly is ~1,500 rows over the current
 * tape, daily is ~65. A minute bucket would be ~90,000 rows and is deliberately
 * not offered, because a route that sometimes returns 20MB is a route that
 * sometimes times out after being paid for.
 */
export const HISTORY_BUCKETS = Object.freeze({ hour: 3_600_000, day: 86_400_000 });

/**
 * The complete recorded history for one symbol.
 *
 * Every other route on this tape caps at 168 hours. This one does not, and that
 * is the whole product: the tape holds far more depth than anything sells, and
 * a liquidation record cannot be backfilled after the fact, so the depth is the
 * part that is genuinely scarce.
 *
 * Two honesty problems are specific to selling history, and both are answered
 * in the payload rather than in prose a buyer will not read.
 *
 * First, coverage_start is per SYMBOL, not per tape. This tape began on one
 * date; an individual symbol first appears whenever it first liquidated, which
 * can be weeks later. Returning "full history" without saying where this
 * symbol's record starts invites the buyer to read our start date as the
 * market's, which is the coverage-gap-as-market-fact failure the whole service
 * exists to avoid.
 *
 * Second, an absent bucket is ambiguous. A quiet hour and an hour when the
 * collector was down produce exactly the same absence, and this tape cannot
 * tell them apart. Rather than emit fabricated zero rows, the series carries
 * only observed buckets and the payload states max_gap_buckets, so a buyer can
 * see the largest unobserved run and decide for themselves whether to trust it.
 */
export function liquidationHistory(store, { symbol, bucket = 'hour', now = Date.now() }) {
  const key = typeof bucket === 'string' ? bucket.trim().toLowerCase() : '';
  const width = HISTORY_BUCKETS[key];
  if (!width) {
    return unmeasured({ source: SOURCE, basis: "bucket must be 'hour' or 'day'" });
  }

  const res = resolveSymbol(store, symbol);
  if (!res.symbol) return resolutionEnvelope(res, symbol);

  const { rows: spanRows, failure: spanFailure } = store.query(
    'SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS n FROM liquidations WHERE symbol = ?',
    [res.symbol],
  );
  if (spanFailure) return unmeasured({ source: SOURCE, basis: BASIS, failure: { reason: spanFailure } });

  const first = Number(spanRows?.[0]?.first_ts);
  const last = Number(spanRows?.[0]?.last_ts);
  const spanCount = Number(spanRows?.[0]?.n);
  if (!Number.isFinite(first) || !Number.isFinite(last) || !spanCount) {
    return absent({
      asOf: now,
      source: SOURCE,
      basis: `${res.symbol} is carried by this tape but holds no liquidation rows`,
    });
  }

  const { rows, failure } = store.query(
    'SELECT CAST(ts / ? AS INTEGER) AS b, exchange, side, COUNT(*) AS n, SUM(usd) AS usd ' +
      'FROM liquidations WHERE symbol = ? GROUP BY b, exchange, side ORDER BY b',
    [width, res.symbol],
  );
  if (failure) return unmeasured({ source: SOURCE, basis: BASIS, failure: { reason: failure } });
  if (!rows.length) {
    return absent({
      asOf: now,
      source: SOURCE,
      basis: `${res.symbol} is covered by this tape and produced no bucketed rows`,
    });
  }

  const byBucket = new Map();
  const exchanges = new Set();
  const unknownSides = new Set();
  let totalUsd = 0;
  let otherUsd = 0;
  let countedRows = 0;

  for (const r of rows) {
    const usd = Number(r.usd);
    const n = Number(r.n);
    const b = Number(r.b);
    if (!Number.isFinite(usd) || !Number.isFinite(n) || !Number.isFinite(b)) continue;
    const ex = String(r.exchange);
    exchanges.add(ex);
    let slot = byBucket.get(b);
    if (!slot) {
      slot = { rows: 0, usd: 0, longs: 0, shorts: 0, other: 0, by_exchange: {} };
      byBucket.set(b, slot);
    }
    slot.rows += n;
    slot.usd += usd;
    slot.by_exchange[ex] = (slot.by_exchange[ex] ?? 0) + usd;
    const liquidated = SIDE_MEANING[r.side];
    if (liquidated === 'longs') slot.longs += usd;
    else if (liquidated === 'shorts') slot.shorts += usd;
    else {
      slot.other += usd;
      otherUsd += usd;
      unknownSides.add(String(r.side));
    }
    totalUsd += usd;
    countedRows += n;
  }

  if (!byBucket.size) {
    return unmeasured({
      source: SOURCE,
      basis: BASIS,
      failure: { reason: 'every bucketed row carried a non finite value' },
    });
  }

  const ordered = [...byBucket.keys()].sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const gap = ordered[i] - ordered[i - 1] - 1;
    if (gap > maxGap) maxGap = gap;
  }

  const series = ordered.map((b) => {
    const s = byBucket.get(b);
    return {
      ts: b * width,
      rows: s.rows,
      usd: round2(s.usd),
      longs_usd: round2(s.longs),
      shorts_usd: round2(s.shorts),
      other_usd: round2(s.other),
      by_exchange: Object.fromEntries(
        Object.entries(s.by_exchange).map(([k, v]) => [k, round2(v)]),
      ),
    };
  });

  const spanBuckets = Math.floor(last / width) - Math.floor(first / width) + 1;

  return measured(
    {
      symbol: res.symbol,
      requested: symbol,
      bucket: key,
      coverage_start: first,
      coverage_end: last,
      total_usd: round2(totalUsd),
      rows: countedRows,
      buckets_returned: series.length,
      buckets_in_span: spanBuckets,
      max_gap_buckets: maxGap,
      exchanges: [...exchanges].sort(),
      series,
    },
    {
      asOf: now,
      source: SOURCE,
      basis: `${BASIS}; the complete recorded history for ${res.symbol} on this tape, bucketed by ${key}`,
      control: {
        symbol_resolution: res.matched,
        coverage_note:
          'coverage_start is when this tape first observed this symbol, not when the market began trading it',
        gap_semantics:
          'the series carries only buckets in which liquidations were observed; an absent bucket means none were seen, and this tape cannot distinguish a quiet market from a collector outage, so read max_gap_buckets before treating absences as zeroes',
        side_convention:
          'Sell liquidates a short, Buy liquidates a long; the split is by what was liquidated',
        reconciliation:
          'per bucket longs_usd + shorts_usd + other_usd equals usd before rounding; each field is rounded to the cent independently, so a visible sum can differ by up to a cent',
        unclassified_sides: unknownSides.size ? [...unknownSides] : undefined,
        exchange_reporting: pickExchangeNotes([...exchanges]),
        caveat: 'exchange totals are not directly comparable; see exchange_reporting',
      },
    },
  );
}

export const HANDLERS = Object.freeze({
  liquidation_window: liquidationWindow,
  liquidation_cascade: liquidationCascade,
  liquidation_universe: liquidationUniverse,
  venue_integrity: venueIntegrity,
  liquidation_history: liquidationHistory,
});
