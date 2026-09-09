import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { liquidationHistory } from '../src/tape.mjs';

const H = 3_600_000;
const T0 = 1_780_000_000_000; // an exact multiple of an hour is not assumed

/** The production schema, verbatim. */
function makeStore(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE liquidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
    size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL,
    exchange TEXT NOT NULL DEFAULT 'bybit')`);
  const ins = db.prepare(
    'INSERT INTO liquidations (ts,symbol,side,size,price,usd,exchange) VALUES (?,?,?,?,?,?,?)',
  );
  for (const r of rows) ins.run(r.ts, r.symbol, r.side, 1, 1, r.usd, r.exchange ?? 'bybit');
  return {
    query(sql, params = []) {
      try {
        return { rows: db.prepare(sql).all(...params), failure: null };
      } catch (err) {
        return { rows: null, failure: `tape query failed: ${err.message}` };
      }
    },
  };
}

const brokenStore = { query: () => ({ rows: null, failure: 'tape unavailable: disk gone' }) };

test('bucket must be hour or day', () => {
  const s = makeStore([{ ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 10 }]);
  for (const bad of ['minute', '', 'HOURS', null, 5]) {
    const r = liquidationHistory(s, { symbol: 'SOL', bucket: bad });
    assert.equal(r.status, 'unmeasured', `bucket ${String(bad)} should be rejected`);
  }
  assert.equal(liquidationHistory(s, { symbol: 'SOL', bucket: ' HOUR ' }).status, 'measured');
  assert.equal(liquidationHistory(s, { symbol: 'SOL' }).status, 'measured');
});

test('a symbol the tape does not carry is unmeasured, never absent', () => {
  const s = makeStore([{ ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 10 }]);
  const r = liquidationHistory(s, { symbol: 'DOGE' });
  assert.equal(r.status, 'unmeasured');
  assert.equal(r.failure.reason, 'symbol_not_covered');
  assert.equal(r.value, null);
});

test('a malformed symbol is unmeasured and says so', () => {
  const s = makeStore([{ ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 10 }]);
  assert.equal(liquidationHistory(s, { symbol: '' }).status, 'unmeasured');
  assert.equal(liquidationHistory(s, { symbol: 'a/b' }).status, 'unmeasured');
});

test('a store failure is unmeasured, so it is never billed', () => {
  const r = liquidationHistory(brokenStore, { symbol: 'SOL' });
  assert.equal(r.status, 'unmeasured');
  assert.match(JSON.stringify(r.failure), /disk gone/);
});

test('bare symbol resolves through a quote suffix', () => {
  const s = makeStore([{ ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 10 }]);
  const r = liquidationHistory(s, { symbol: 'sol' });
  assert.equal(r.status, 'measured');
  assert.equal(r.value.symbol, 'SOLUSDT');
  assert.equal(r.value.requested, 'sol');
  assert.equal(r.control.symbol_resolution, 'suffixed');
});

test('coverage_start is this symbol first row, not the tape first row', () => {
  const s = makeStore([
    { ts: T0, symbol: 'BTCUSDT', side: 'Buy', usd: 5 },
    { ts: T0 + 50 * H, symbol: 'ZECUSDT', side: 'Buy', usd: 7 },
    { ts: T0 + 60 * H, symbol: 'ZECUSDT', side: 'Sell', usd: 3 },
  ]);
  const r = liquidationHistory(s, { symbol: 'ZEC' });
  assert.equal(r.status, 'measured');
  assert.equal(r.value.coverage_start, T0 + 50 * H);
  assert.equal(r.value.coverage_end, T0 + 60 * H);
  assert.notEqual(r.value.coverage_start, T0);
});

test('hourly buckets aggregate by hour and carry side and exchange splits', () => {
  const s = makeStore([
    { ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 100, exchange: 'binance' },
    { ts: T0 + 60_000, symbol: 'SOLUSDT', side: 'Sell', usd: 40, exchange: 'bybit' },
    { ts: T0 + H, symbol: 'SOLUSDT', side: 'Buy', usd: 10, exchange: 'okx' },
  ]);
  const r = liquidationHistory(s, { symbol: 'SOL', bucket: 'hour' });
  assert.equal(r.status, 'measured');
  assert.equal(r.value.series.length, 2);
  const [b0, b1] = r.value.series;
  assert.equal(b0.usd, 140);
  assert.equal(b0.longs_usd, 100);
  assert.equal(b0.shorts_usd, 40);
  assert.equal(b0.rows, 2);
  assert.deepEqual(b0.by_exchange, { binance: 100, bybit: 40 });
  assert.equal(b1.usd, 10);
  assert.equal(b1.ts - b0.ts, H);
  assert.equal(r.value.total_usd, 150);
  assert.equal(r.value.rows, 3);
  assert.deepEqual(r.value.exchanges, ['binance', 'bybit', 'okx']);
});

test('daily bucketing collapses the same rows into one bucket', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push({ ts: T0 + i * H, symbol: 'SOLUSDT', side: 'Buy', usd: 10 });
  }
  const s = makeStore(rows);
  const hourly = liquidationHistory(s, { symbol: 'SOL', bucket: 'hour' });
  const daily = liquidationHistory(s, { symbol: 'SOL', bucket: 'day' });
  assert.equal(hourly.value.series.length, 6);
  assert.ok(daily.value.series.length < hourly.value.series.length);
  assert.equal(daily.value.total_usd, hourly.value.total_usd);
  assert.equal(daily.value.rows, hourly.value.rows);
});

test('an unrecognised side is kept as other_usd and named, never dropped', () => {
  const s = makeStore([
    { ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 10 },
    { ts: T0, symbol: 'SOLUSDT', side: 'Weird', usd: 25 },
  ]);
  const r = liquidationHistory(s, { symbol: 'SOL' });
  assert.equal(r.value.total_usd, 35);
  assert.equal(r.value.series[0].other_usd, 25);
  assert.deepEqual(r.control.unclassified_sides, ['Weird']);
  const b = r.value.series[0];
  assert.equal(b.longs_usd + b.shorts_usd + b.other_usd, b.usd);
});

test('max_gap_buckets reports the longest unobserved run', () => {
  const s = makeStore([
    { ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 1 },
    { ts: T0 + H, symbol: 'SOLUSDT', side: 'Buy', usd: 1 },
    { ts: T0 + 6 * H, symbol: 'SOLUSDT', side: 'Buy', usd: 1 },
    { ts: T0 + 7 * H, symbol: 'SOLUSDT', side: 'Buy', usd: 1 },
  ]);
  const r = liquidationHistory(s, { symbol: 'SOL', bucket: 'hour' });
  assert.equal(r.value.buckets_returned, 4);
  assert.equal(r.value.max_gap_buckets, 4);
  assert.equal(r.value.buckets_in_span, 8);
});

test('a contiguous series reports no gap', () => {
  const s = makeStore([
    { ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 1 },
    { ts: T0 + H, symbol: 'SOLUSDT', side: 'Buy', usd: 1 },
  ]);
  const r = liquidationHistory(s, { symbol: 'SOL' });
  assert.equal(r.value.max_gap_buckets, 0);
  assert.equal(r.value.buckets_returned, r.value.buckets_in_span);
});

test('the series is ordered and every bucket ts is a multiple of the width', () => {
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    rows.push({ ts: T0 + i * 900_000, symbol: 'SOLUSDT', side: i % 2 ? 'Buy' : 'Sell', usd: i + 1 });
  }
  const r = liquidationHistory(makeStore(rows), { symbol: 'SOL', bucket: 'hour' });
  const ts = r.value.series.map((x) => x.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  for (const t of ts) assert.equal(t % H, 0);
});

test('totals reconcile against the raw rows', () => {
  const rows = [];
  let expected = 0;
  for (let i = 0; i < 50; i += 1) {
    const usd = (i * 7.77) % 91;
    expected += usd;
    rows.push({ ts: T0 + i * 137_000, symbol: 'SOLUSDT', side: i % 3 ? 'Buy' : 'Sell', usd });
  }
  const r = liquidationHistory(makeStore(rows), { symbol: 'SOL' });
  assert.equal(r.value.total_usd, Math.round(expected * 100) / 100);
  assert.equal(r.value.rows, 50);
  const summed = r.value.series.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(summed - r.value.total_usd) < 0.05);
});

test('the envelope carries the disclosures that make history sellable', () => {
  const s = makeStore([{ ts: T0, symbol: 'SOLUSDT', side: 'Buy', usd: 10, exchange: 'binance' }]);
  const r = liquidationHistory(s, { symbol: 'SOL', now: T0 + 5 });
  assert.equal(r.asOf, T0 + 5);
  assert.match(r.control.coverage_note, /not when the market began trading/);
  assert.match(r.control.gap_semantics, /cannot distinguish a quiet market from a collector outage/);
  assert.ok(r.control.exchange_reporting.binance);
  assert.equal(r.control.unclassified_sides, undefined);
});
