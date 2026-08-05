import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { Ledger } from '../src/ledger.mjs';
import { compileCatalog, CATALOG } from '../src/catalog.mjs';
import { FakeTapeStore, rows, NOW, baseEnv } from './helpers.mjs';
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
    assert.equal(b.sweep_price_usdc, '0.2');
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
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=1');
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
    const res = await s.get('/v1/liquidations/window?symbol=ETHUSDT&hours=1');
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
    const res = await s.get('/v1/liquidations/window?symbol=DOGE&hours=1');
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
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=1');
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
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=9999');
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
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=1');
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
    assert.equal((await s.get('/v1/nope')).status, 404);
  } finally {
    await s.close();
  }
});

test('the app refuses to build if the catalog names a handler that does not exist', () => {
  const cfg = loadConfig(baseEnv());
  assert.throws(
    () => createApp(cfg, { withPaywall: false, catalog: [{ ...CATALOG[0], id: 'ghost_route', path: '/v1/ghost' }] }),
    /has no handler; the catalog and code disagree/,
  );
});

test('the bare root redirects to the catalog rather than answering 404', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const res = await fetch(`${s.base}/`, { redirect: 'manual' });
    assert.equal(res.status, 302, 'a 404 on the root reads as a dead service');
    assert.equal(res.headers.get('location'), '/catalog');
  } finally {
    await s.close();
  }
});

test('following the root redirect lands on a usable catalog', async () => {
  const s = await serve({ withPaywall: false });
  try {
    const body = await (await fetch(`${s.base}/`)).json();
    assert.ok(Array.isArray(body.routes) && body.routes.length > 0);
  } finally {
    await s.close();
  }
});
