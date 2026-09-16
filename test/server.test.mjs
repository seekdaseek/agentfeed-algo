import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { Ledger } from '../src/ledger.mjs';
import { compileCatalog, CATALOG } from '../src/catalog.mjs';
import { TITLE, tapeSnapshot, resetTapeCache } from '../src/landing.mjs';
import { FakeTapeStore, sqliteFixtureStore, rows, NOW, baseEnv } from './helpers.mjs';
import { MissingTapeStore } from '../src/tape.mjs';

/** Boot the app on an ephemeral port and hand back a fetch bound to it. */
async function serve(opts = {}) {
  const cfg = loadConfig(baseEnv());
  const app = createApp(cfg, { now: () => NOW, ledger: new Ledger('/dev/null'), ...opts });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    cfg,
    base: `http://127.0.0.1:${port}`,
    get: (path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: 'application/json' } }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('health answers without payment and states whether a tape exists', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const res = await s.get('/health');
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.ok, true);
    assert.equal(b.routes, CATALOG.length);
    assert.equal(b.tape, 'absent');
  } finally {
    await s.close();
  }
});

test('the catalog is free, complete, and prices match the compiled ones', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const b = await (await s.get('/catalog')).json();
    const compiled = compileCatalog();
    assert.equal(b.routes.length, compiled.length);
    assert.equal(b.sweep_price_usdc, '5.2');
    assert.equal(b.asset.asaId, s.cfg.usdcAsaId);
    assert.equal(b.payTo, s.cfg.payTo);
    for (const entry of compiled) {
      const r = b.routes.find((x) => x.id === entry.id);
      assert.equal(r.price_usdc, entry.price, `price drift on ${entry.id}`);
      assert.equal(r.path, entry.path);
    }
    assert.ok(b.status_vocabulary.unmeasured.includes('never billed'));
  } finally {
    await s.close();
  }
});

test('the well known manifest lists every resource with base unit prices', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const b = await (await s.get('/.well-known/x402')).json();
    assert.equal(b.network, s.cfg.caip2);
    assert.equal(b.resources.length, CATALOG.length);
    for (const r of b.resources) {
      assert.ok(r.resource.startsWith(s.cfg.baseUrl));
      assert.match(r.price.amount, /^\d+$/);
      assert.equal(r.price.asset, s.cfg.usdcAsaId);
    }
  } finally {
    await s.close();
  }
});

test('a measured answer is served with its basis and control attached', async () => {
  const s = await serve({ withPaywall: false, store: new FakeTapeStore(rows()) });
  try {
    const res = await s.get('/v2/liquidations/window?symbol=SOL&hours=1');
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.status, 'measured');
    assert.equal(b.value.total_usd, 3500);
    assert.equal(b.route, 'liquidation_window');
    assert.ok(b.control.exchange_reporting.bybit);
    assert.equal(b.value.symbol, 'SOLUSDT');
    assert.equal(b.value.longs_usd + b.value.shorts_usd, b.value.total_usd);
    assert.match(b.disclosure, /never billed/);
  } finally {
    await s.close();
  }
});

test('an absent answer is a paid 200, because a quiet market is a real finding', async () => {
  // ETHUSDT is carried by this tape but its only row sits outside the window,
  // which is the genuine quiet-market case rather than a coverage gap.
  const quiet = new FakeTapeStore([
    ...rows(),
    { symbol: 'ETHUSDT', exchange: 'bybit', side: 'Buy', ts: NOW - 100 * 3600_000, usd: 42 },
  ]);
  const s = await serve({ withPaywall: false, store: quiet });
  try {
    const res = await s.get('/v2/liquidations/window?symbol=ETHUSDT&hours=1');
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.status, 'absent');
    assert.equal(b.billing, undefined, 'absent is billable, so no refund note');
  } finally {
    await s.close();
  }
});

test('a symbol the tape does not carry is 503 and not billed, never a quiet market', async () => {
  const s = await serve({ withPaywall: false, store: new FakeTapeStore(rows()) });
  try {
    const res = await s.get('/v2/liquidations/window?symbol=DOGE&hours=1');
    assert.equal(res.status, 503, 'a coverage gap must not be sold as a finding');
    const b = await res.json();
    assert.equal(b.status, 'unmeasured');
    assert.equal(b.failure.reason, 'symbol_not_covered');
    assert.match(b.billing, /cost you nothing/);
  } finally {
    await s.close();
  }
});

test('an unmeasured answer is 503 and says the caller was not charged', async () => {
  const s = await serve({ withPaywall: false, store: new FakeTapeStore(rows()).failWith('disk gone') });
  try {
    const res = await s.get('/v2/liquidations/window?symbol=SOL&hours=1');
    assert.equal(res.status, 503);
    const b = await res.json();
    assert.equal(b.status, 'unmeasured');
    assert.match(b.billing, /cost you nothing/);
    assert.match(b.failure.reason, /disk gone/);
  } finally {
    await s.close();
  }
});

test('no tape means every paid route is 503, not a page of confident zeros', async () => {
  const s = await serve({ withPaywall: false, store: new MissingTapeStore() });
  try {
    for (const entry of CATALOG) {
      const res = await s.get(`${entry.path}?symbol=SOL`);
      assert.equal(res.status, 503, `${entry.path} should refuse to bill`);
      assert.equal((await res.json()).status, 'unmeasured');
    }
  } finally {
    await s.close();
  }
});

test('a malformed parameter is unmeasured rather than a silent default', async () => {
  const s = await serve({ withPaywall: false, store: new FakeTapeStore(rows()) });
  try {
    const res = await s.get('/v2/liquidations/window?symbol=SOL&hours=9999');
    assert.equal(res.status, 503);
    assert.match((await res.json()).basis, /hours must be between 1 and 168/);
  } finally {
    await s.close();
  }
});

test('a handler that throws returns unmeasured, never a fabricated body', async () => {
  const exploding = {
    query() {
      throw new Error('boom');
    },
  };
  const s = await serve({ withPaywall: false, store: exploding });
  try {
    const res = await s.get('/v2/liquidations/window?symbol=SOL&hours=1');
    assert.equal(res.status, 503);
    const b = await res.json();
    assert.equal(b.status, 'unmeasured');
    assert.match(b.failure.reason, /boom/);
  } finally {
    await s.close();
  }
});

test('an unknown path is a clean 404', async () => {
  const s = await serve({ withPaywall: false });
  try {
    assert.equal((await s.get('/v2/nope')).status, 404);
    // The legacy namespace is a fixed list of aliases, not a wildcard.
    assert.equal((await s.get('/v1/nope')).status, 404);
  } finally {
    await s.close();
  }
});

test('the app refuses to build if the catalog names a handler that does not exist', () => {
  const cfg = loadConfig(baseEnv());
  assert.throws(
    () => createApp(cfg, { withPaywall: false, catalog: [{ ...CATALOG[0], id: 'ghost_route', path: '/v2/ghost', legacyPath: '/v1/ghost' }] }),
    /has no handler; the catalog and code disagree/,
  );
});

test('the bare root serves an HTML page carrying a crawlable title', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200, 'a 404 or a redirect on the root reads as a dead service');
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
    assert.equal(
      title,
      TITLE,
      'directories build the merchant label from this title; without it the service lists as a wallet address',
    );
    assert.match(html, /<meta property="og:title" content="[^"]+"/);
    assert.match(html, /rel="apple-touch-icon"/);
  } finally {
    await s.close();
  }
});

test('the landing page lists every priced route at the catalog price', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const html = await (await fetch(`${s.base}/`)).text();
    for (const entry of CATALOG) {
      assert.ok(html.includes(entry.path), `landing page omits ${entry.path}`);
      assert.ok(html.includes(`$${entry.price}`), `landing page omits the price of ${entry.id}`);
    }
  } finally {
    await s.close();
  }
});

test('both icon paths answer with a PNG so a crawler finds one of them', async () => {
  const s = await serve({ withPaywall: false });
  try {
    for (const p of ['/favicon.ico', '/apple-touch-icon.png']) {
      const res = await fetch(`${s.base}${p}`);
      assert.equal(res.status, 200, `${p} did not answer`);
      assert.match(res.headers.get('content-type') ?? '', /image\/png/);
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${p} is not a PNG`);
    }
  } finally {
    await s.close();
  }
});

test('a broken tape renders the landing panel as unmeasured, never as zeros', () => {
  resetTapeCache();
  const snap = tapeSnapshot(new MissingTapeStore(), { now: () => NOW });
  assert.equal(snap.status, 'unmeasured');
  assert.ok(snap.detail, 'an unmeasured panel must say what failed');
  assert.equal(snap.events, undefined, 'a failed read must not become a count');
});

test('the landing page shows the unmeasured panel when the tape is missing', async () => {
  resetTapeCache();
  const s = await serve({ withPaywall: false, store: new MissingTapeStore() });
  try {
    const html = await (await fetch(`${s.base}/`)).text();
    assert.match(html, /unmeasured/);
    assert.ok(!/liquidations recorded/.test(html), 'a missing tape must not render a stat block');
  } finally {
    resetTapeCache();
    await s.close();
  }
});

test('the landing page carries the working surfaces a judge or agent would follow', async () => {
  resetTapeCache();
  const s = await serve({ withPaywall: false });
  try {
    const html = await (await fetch(`${s.base}/`)).text();
    for (const href of ['/catalog', '/health', '/.well-known/x402', 'github.com/seekdaseek/agentfeed-algo']) {
      assert.ok(html.includes(href), `landing page omits ${href}`);
    }
  } finally {
    resetTapeCache();
    await s.close();
  }
});

test('the catalog stays reachable at its own path now that the root is a page', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const body = await (await fetch(`${s.base}/catalog`)).json();
    assert.ok(Array.isArray(body.routes) && body.routes.length > 0);
  } finally {
    await s.close();
  }
});

/**
 * The history route, driven over HTTP rather than through the handler.
 *
 * These exist because of a bug no handler level test could have caught. The
 * handler had always validated `bucket` and had always defaulted it to 'hour',
 * and its own tests passed. The server simply never forwarded the query
 * parameter, so every request was answered hourly: bucket=day quietly returned
 * the wrong resolution, and an invalid bucket returned a confident hourly answer
 * and was BILLED, when the handler would have refused it as unmeasured and
 * charged nothing. The seam between the router and the handler is where it
 * lived, so that is where these tests sit.
 */
const HB = 3_600_000;
const HT0 = 1_780_000_000_000;

function historyStore() {
  const rowsIn = [];
  for (let i = 0; i < 6; i += 1) {
    rowsIn.push({ ts: HT0 + i * HB, symbol: 'SOLUSDT', side: 'Buy', usd: 10, exchange: 'bybit' });
  }
  return sqliteFixtureStore(rowsIn);
}

test('bucket=day reaches the handler and is answered in daily buckets', async () => {
  const s = await serve({ withPaywall: false, store: historyStore() });
  try {
    const res = await s.get('/v2/liquidations/history?symbol=SOL&bucket=day');
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.status, 'measured');
    assert.equal(b.value.bucket, 'day', 'bucket=day was ignored and answered as hourly');

    const hourly = await (await s.get('/v2/liquidations/history?symbol=SOL&bucket=hour')).json();
    assert.equal(hourly.value.bucket, 'hour');
    assert.equal(hourly.value.series.length, 6);
    assert.ok(
      b.value.series.length < hourly.value.series.length,
      'a daily answer must collapse the hourly buckets, not repeat them',
    );
    assert.equal(b.value.total_usd, hourly.value.total_usd, 'resolution changes, totals do not');
  } finally {
    await s.close();
  }
});

test('an invalid bucket is unmeasured and unbilled, never a confident hourly answer', async () => {
  const s = await serve({ withPaywall: false, store: historyStore() });
  try {
    const res = await s.get('/v2/liquidations/history?symbol=SOL&bucket=minute');
    assert.equal(res.status, 503, 'an invalid bucket was billed as though it had been understood');
    const b = await res.json();
    assert.equal(b.status, 'unmeasured');
    assert.match(b.basis, /bucket must be/);
    assert.match(b.billing, /cost you nothing/);
    assert.equal(b.value, null, 'a rejected parameter must not come back with data attached');
  } finally {
    await s.close();
  }
});

test('an omitted bucket still defaults to hourly, so the fix broke no caller', async () => {
  const s = await serve({ withPaywall: false, store: historyStore() });
  try {
    const b = await (await s.get('/v2/liquidations/history?symbol=SOL')).json();
    assert.equal(b.status, 'measured');
    assert.equal(b.value.bucket, 'hour');
  } finally {
    await s.close();
  }
});

test('the legacy path answers from the same handler as its replacement', async () => {
  const s = await serve({ withPaywall: false, store: new FakeTapeStore(rows()) });
  try {
    const current = await (await s.get('/v2/liquidations/window?symbol=SOL&hours=1')).json();
    const legacy = await (await s.get('/v1/liquidations/window?symbol=SOL&hours=1')).json();
    assert.equal(legacy.status, 'measured');
    assert.equal(legacy.route, 'liquidation_window');
    assert.deepEqual(legacy.value, current.value, 'the old URL must not answer something else');
  } finally {
    await s.close();
  }
});

test('every catalog entry answers on both its current and its legacy path', async () => {
  const s = await serve({ withPaywall: false, store: new MissingTapeStore() });
  try {
    for (const entry of compileCatalog()) {
      assert.ok(entry.legacyPath, `${entry.id} lost its legacy alias`);
      assert.match(entry.path, /^\/v2\//, `${entry.id} is not published under /v2`);
      assert.match(entry.legacyPath, /^\/v1\//, `${entry.id} legacy alias is not a /v1 path`);
      for (const path of [entry.path, entry.legacyPath]) {
        const res = await s.get(`${path}?symbol=SOL`);
        // No tape, so both must refuse to bill rather than 404.
        assert.equal(res.status, 503, `${path} did not reach a handler`);
        assert.equal((await res.json()).route, entry.id, `${path} reached the wrong handler`);
      }
    }
  } finally {
    await s.close();
  }
});

test('only /v2 is advertised, on every surface an agent reads', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const catalog = await (await s.get('/catalog')).json();
    for (const r of catalog.routes) {
      assert.match(r.path, /^\/v2\//, `/catalog still advertises ${r.path}`);
    }
    assert.equal(JSON.stringify(catalog).includes('/v1/'), false, '/catalog leaks a legacy path');

    const manifest = await (await s.get('/.well-known/x402')).json();
    assert.equal(JSON.stringify(manifest).includes('/v1/'), false, 'the manifest leaks a legacy path');
    for (const r of manifest.resources) {
      assert.match(r.resource, /\/v2\//, `the manifest still advertises ${r.resource}`);
    }

    const html = await (await fetch(`${s.base}/`)).text();
    assert.equal(html.includes('/v1/'), false, 'the landing page still lists a legacy path');
    assert.ok(html.includes('/v2/liquidations/window'), 'the landing page lists no current path');
  } finally {
    await s.close();
  }
});
