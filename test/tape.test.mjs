import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  liquidationWindow,
  liquidationCascade,
  liquidationUniverse,
  venueIntegrity,
  resolveSymbol,
  MissingTapeStore,
  EXCHANGE_NOTES,
  SIDE_MEANING,
  QUOTE_SUFFIXES,
  HANDLERS,
} from '../src/tape.mjs';
import { CATALOG } from '../src/catalog.mjs';
import { FakeTapeStore, rows, NOW } from './helpers.mjs';

// ---- symbol resolution, the part that stops a coverage gap becoming a finding ----

test('a bare symbol resolves to the traded pair the tape actually carries', () => {
  const r = resolveSymbol(new FakeTapeStore(rows()), 'SOL');
  assert.equal(r.symbol, 'SOLUSDT');
  assert.equal(r.matched, 'suffixed');
});

test('an exact pair resolves as exact', () => {
  const r = resolveSymbol(new FakeTapeStore(rows()), 'SOLUSDT');
  assert.equal(r.symbol, 'SOLUSDT');
  assert.equal(r.matched, 'exact');
});

test('resolution is case and whitespace tolerant', () => {
  assert.equal(resolveSymbol(new FakeTapeStore(rows()), '  sol  ').symbol, 'SOLUSDT');
});

test('a symbol the tape does not carry resolves to nothing, and lists what it tried', () => {
  const r = resolveSymbol(new FakeTapeStore(rows()), 'DOGE');
  assert.equal(r.symbol, null);
  assert.equal(r.matched, null);
  assert.deepEqual(r.candidates, ['DOGE', ...QUOTE_SUFFIXES.map((q) => `DOGE${q}`)]);
});

test('AN UNCOVERED SYMBOL IS UNMEASURED, NOT ABSENT', () => {
  // This is the whole point. Answering "no liquidations for DOGE" would be a
  // finding, and a false one: the truth is we never carried that symbol.
  const e = liquidationWindow(new FakeTapeStore(rows()), { symbol: 'DOGE', hours: 24, now: NOW });
  assert.equal(e.status, 'unmeasured', 'a coverage gap must never be reported as a quiet market');
  assert.equal(e.failure.reason, 'symbol_not_covered');
  assert.match(e.basis, /coverage gap on our side, not a statement that the market was quiet/);
});

test('a covered symbol with an empty window IS absent, because that is a real finding', () => {
  const store = new FakeTapeStore(rows());
  const e = liquidationWindow(store, { symbol: 'BTCUSDT', hours: 1, now: NOW + 10 * 3600_000 });
  assert.equal(e.status, 'absent');
  assert.match(e.basis, /is covered by this tape and had no liquidations/);
});

// ---- the window ----

test('a populated window is measured and reports per exchange', () => {
  const e = liquidationWindow(new FakeTapeStore(rows()), { symbol: 'SOL', hours: 1, now: NOW });
  assert.equal(e.status, 'measured');
  assert.equal(e.value.symbol, 'SOLUSDT');
  assert.equal(e.value.requested, 'SOL');
  assert.equal(e.value.total_usd, 3500);
  assert.equal(e.value.rows, 3);
  assert.deepEqual(Object.keys(e.value.by_exchange).sort(), ['binance', 'bybit']);
});

test('the long and short split follows the schema side convention', () => {
  // Buy liquidates a long: 1000 + 500. Sell liquidates a short: 2000.
  const e = liquidationWindow(new FakeTapeStore(rows()), { symbol: 'SOL', hours: 1, now: NOW });
  assert.equal(e.value.longs_usd, 1500);
  assert.equal(e.value.shorts_usd, 2000);
  assert.equal(e.value.longs_usd + e.value.shorts_usd, e.value.total_usd);
  assert.match(e.control.side_convention, /Sell liquidates a short/);
});

test('the window respects its own boundary', () => {
  const store = new FakeTapeStore(rows());
  assert.equal(liquidationWindow(store, { symbol: 'SOL', hours: 1, now: NOW }).value.rows, 3);
  assert.equal(liquidationWindow(store, { symbol: 'SOL', hours: 24, now: NOW }).value.rows, 4);
});

test('the resolution used is disclosed in the control block', () => {
  const e = liquidationWindow(new FakeTapeStore(rows()), { symbol: 'SOL', hours: 1, now: NOW });
  assert.equal(e.control.symbol_resolution, 'suffixed');
  const exact = liquidationWindow(new FakeTapeStore(rows()), { symbol: 'SOLUSDT', hours: 1, now: NOW });
  assert.equal(exact.control.symbol_resolution, 'exact');
});

// ---- failure paths ----

test('a broken tape is UNMEASURED and never a zero', () => {
  const store = new FakeTapeStore(rows()).failWith('database is locked');
  const e = liquidationWindow(store, { symbol: 'SOL', hours: 1, now: NOW });
  assert.equal(e.status, 'unmeasured');
  assert.match(e.failure.reason, /database is locked/);
});

test('no tape configured is unmeasured everywhere, not an empty market', () => {
  const store = new MissingTapeStore();
  assert.equal(liquidationWindow(store, { symbol: 'SOL', now: NOW }).status, 'unmeasured');
  assert.equal(liquidationCascade(store, { symbol: 'SOL', now: NOW }).status, 'unmeasured');
  assert.equal(liquidationUniverse(store, { now: NOW }).status, 'unmeasured');
  assert.equal(venueIntegrity(store, { now: NOW }).status, 'unmeasured');
});

test('a bad window is refused before the tape is touched at all', () => {
  const store = new FakeTapeStore(rows());
  assert.equal(liquidationWindow(store, { symbol: 'SOL', hours: 999, now: NOW }).status, 'unmeasured');
  assert.equal(liquidationCascade(store, { symbol: 'SOL', minutes: 1, now: NOW }).status, 'unmeasured');
  assert.equal(store.calls.length, 0, 'a malformed window must not reach the database');
});

test('a malformed symbol is unmeasured and never queried', () => {
  const store = new FakeTapeStore(rows());
  assert.equal(liquidationWindow(store, { symbol: 'S OL', hours: 1, now: NOW }).status, 'unmeasured');
  assert.equal(liquidationWindow(store, { symbol: '', hours: 1, now: NOW }).status, 'unmeasured');
  assert.equal(store.calls.length, 0);
});

// ---- cascade ----

test('cascade concentration is one when everything lands in a single minute', () => {
  const t = NOW - 30_000;
  const store = new FakeTapeStore([
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: t, usd: 500 },
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: t + 1000, usd: 500 },
  ]);
  const e = liquidationCascade(store, { symbol: 'SOL', minutes: 60, now: NOW });
  assert.equal(e.value.concentration, 1);
  assert.equal(e.value.active_minutes, 1);
  assert.equal(e.value.dominant_side, 'longs');
});

test('cascade concentration falls as the same value spreads across minutes', () => {
  const store = new FakeTapeStore(
    [1, 2, 3, 4].map((i) => ({
      symbol: 'SOLUSDT',
      exchange: 'bybit',
      side: 'Sell',
      ts: NOW - 60_000 * i,
      usd: 500,
    })),
  );
  const e = liquidationCascade(store, { symbol: 'SOL', minutes: 60, now: NOW });
  assert.equal(e.value.active_minutes, 4);
  assert.equal(e.value.concentration, 0.25);
  assert.equal(e.control.floor, 0.25);
  assert.equal(e.value.dominant_side, 'shorts');
});

test('an evenly split cascade reports balanced rather than picking a winner', () => {
  const store = new FakeTapeStore([
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: NOW - 10_000, usd: 500 },
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Sell', ts: NOW - 11_000, usd: 500 },
  ]);
  assert.equal(liquidationCascade(store, { symbol: 'SOL', minutes: 60, now: NOW }).value.dominant_side, 'balanced');
});

// ---- universe and exchange integrity ----

test('the universe reports coverage in real pair symbols', () => {
  const e = liquidationUniverse(new FakeTapeStore(rows()), { hours: 24, now: NOW });
  assert.equal(e.value.symbols, 2);
  assert.equal(e.value.top[0].symbol, 'SOLUSDT');
  assert.match(e.basis, /exchange pairs such as SOLUSDT/);
});

test('exchange integrity names which exchanges undercount, because it changes the reading', () => {
  const e = venueIntegrity(new FakeTapeStore(rows()), { hours: 24, now: NOW });
  const bybit = e.value.exchanges.find((v) => v.exchange === 'bybit');
  assert.match(bybit.reporting, /complete unthrottled/);
  const binance = e.value.exchanges.find((v) => v.exchange === 'binance');
  assert.match(binance.reporting, /undercounts during cascades/);
  assert.match(e.control.why_this_matters, /understate cascades/);
});

test('an uncharacterised exchange is said to be uncharacterised, not assumed clean', () => {
  const store = new FakeTapeStore([
    { symbol: 'SOLUSDT', exchange: 'newvenue', side: 'Buy', ts: NOW - 1000, usd: 10 },
  ]);
  assert.match(venueIntegrity(store, { hours: 1, now: NOW }).value.exchanges[0].reporting, /not characterised/);
});

// ---- contracts ----

test('every catalog id has a handler and every handler has a catalog entry', () => {
  assert.deepEqual(Object.keys(HANDLERS).sort(), CATALOG.map((e) => e.id).sort());
});

test('the exchange notes cover the three the tape claims to read', () => {
  assert.deepEqual(Object.keys(EXCHANGE_NOTES).sort(), ['binance', 'bybit', 'okx']);
});

test('the side mapping matches the schema comment exactly', () => {
  assert.equal(SIDE_MEANING.Sell, 'shorts');
  assert.equal(SIDE_MEANING.Buy, 'longs');
});

test('the side split reconciles with the total before rounding', () => {
  const e = liquidationWindow(new FakeTapeStore(rows()), { symbol: 'SOL', hours: 24, now: NOW });
  const v = e.value;
  assert.equal(v.longs_usd + v.shorts_usd + v.other_usd, v.total_usd);
  assert.equal(v.other_usd, 0, 'every row in the fixture has a known side');
  assert.match(e.control.reconciliation, /rounded to the cent independently/);
});

test('a side value the schema never described lands in other_usd and is named', () => {
  const store = new FakeTapeStore([
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: NOW - 1000, usd: 100 },
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Sideways', ts: NOW - 2000, usd: 40 },
  ]);
  const e = liquidationWindow(store, { symbol: 'SOL', hours: 1, now: NOW });
  assert.equal(e.value.longs_usd, 100);
  assert.equal(e.value.shorts_usd, 0);
  assert.equal(e.value.other_usd, 40, 'an unknown side must not vanish into the total');
  assert.equal(e.value.total_usd, 140);
  assert.deepEqual(e.control.unclassified_sides, ['Sideways']);
});

test('no unclassified_sides key appears when every side is known', () => {
  const e = liquidationWindow(new FakeTapeStore(rows()), { symbol: 'SOL', hours: 24, now: NOW });
  assert.equal('unclassified_sides' in e.control && e.control.unclassified_sides !== undefined, false);
});

test('per exchange totals are rounded once, from the raw sum', () => {
  const store = new FakeTapeStore([
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: NOW - 1000, usd: 0.005 },
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: NOW - 2000, usd: 0.005 },
  ]);
  const e = liquidationWindow(store, { symbol: 'SOL', hours: 1, now: NOW });
  // Rounding each row first would give 0.01 + 0.01 = 0.02. Rounding the sum gives 0.01.
  assert.equal(e.value.by_exchange.bybit.usd, 0.01);
});

test('the cascade also reports an unclassified remainder', () => {
  const store = new FakeTapeStore([
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Buy', ts: NOW - 10_000, usd: 100 },
    { symbol: 'SOLUSDT', exchange: 'bybit', side: 'Nonsense', ts: NOW - 11_000, usd: 25 },
  ]);
  const v = liquidationCascade(store, { symbol: 'SOL', minutes: 60, now: NOW }).value;
  assert.equal(v.other_usd, 25);
  assert.equal(v.longs_usd + v.shorts_usd + v.other_usd, v.total_usd);
});
