import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { Ledger } from '../src/ledger.mjs';
import { CATALOG } from '../src/catalog.mjs';
import { FakeTapeStore, rows, NOW, baseEnv } from './helpers.mjs';

/**
 * A facilitator that never touches the network.
 *
 * It implements the three methods FacilitatorClient declares: verify, settle
 * and getSupported. Nothing here is guessed; the shapes come from the package's
 * own type definitions.
 */
class FakeFacilitator {
  constructor(caip2, { supported = true } = {}) {
    this.caip2 = caip2;
    this.supported = supported;
    this.calls = { verify: 0, settle: 0, getSupported: 0 };
  }

  async getSupported() {
    this.calls.getSupported += 1;
    return this.supported
      ? { kinds: [{ x402Version: 2, scheme: 'exact', network: this.caip2 }] }
      : { kinds: [] };
  }

  async verify() {
    this.calls.verify += 1;
    return { isValid: false, invalidReason: 'test facilitator never approves' };
  }

  async settle() {
    this.calls.settle += 1;
    return { success: false, errorReason: 'test facilitator never settles' };
  }
}

async function serveWithPaywall(opts = {}) {
  const cfg = loadConfig(baseEnv());
  const facilitatorClient = new FakeFacilitator(cfg.caip2);
  const app = createApp(cfg, {
    now: () => NOW,
    ledger: new Ledger('/dev/null'),
    store: new FakeTapeStore(rows()),
    facilitatorClient,
    ...opts,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    cfg,
    facilitatorClient,
    get: (path, headers = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: 'application/json', ...headers } }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('with the paywall on, a paid route without payment returns 402', async () => {
  const s = await serveWithPaywall();
  try {
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=1');
    assert.equal(res.status, 402, 'the middleware must challenge, not serve');
  } finally {
    await s.close();
  }
});

test('the 402 body tells an agent the price, the asset and what it unlocks', async () => {
  const s = await serveWithPaywall();
  try {
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=1');
    const text = await res.text();
    assert.match(text, /0\.02/, 'the price must be visible before paying');
    assert.match(text, new RegExp(s.cfg.usdcAsaId), 'the asset id must be visible');
    assert.match(text, /measured/, 'the status vocabulary must be visible');
  } finally {
    await s.close();
  }
});

test('the paid value never leaks through the 402', async () => {
  const s = await serveWithPaywall();
  try {
    const text = await (await s.get('/v1/liquidations/window?symbol=SOL&hours=1')).text();
    assert.equal(/3500/.test(text), false, 'the unpaid response must not contain the measured total');
  } finally {
    await s.close();
  }
});

test('free surfaces stay free with the paywall engaged', async () => {
  const s = await serveWithPaywall();
  try {
    assert.equal((await s.get('/health')).status, 200);
    assert.equal((await s.get('/catalog')).status, 200);
    assert.equal((await s.get('/.well-known/x402')).status, 200);
  } finally {
    await s.close();
  }
});

test('every paid route in the catalog is actually behind the paywall', async () => {
  const s = await serveWithPaywall();
  try {
    for (const entry of CATALOG) {
      const res = await s.get(`${entry.path}?symbol=SOL`);
      assert.equal(res.status, 402, `${entry.path} is not paywalled`);
    }
  } finally {
    await s.close();
  }
});

test('a garbage payment header is rejected rather than accepted', async () => {
  const s = await serveWithPaywall();
  try {
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=1', {
      'X-PAYMENT': 'not-a-real-payment',
    });
    assert.notEqual(res.status, 200, 'an invalid payment must never serve the data');
    assert.equal((await res.text()).includes('3500'), false);
  } finally {
    await s.close();
  }
});

/** A facilitator that is simply down. This is the outage case, not a bad payment. */
class DeadFacilitator {
  async getSupported() { throw new Error('ECONNREFUSED'); }
  async verify() { throw new Error('ECONNREFUSED'); }
  async settle() { throw new Error('ECONNREFUSED'); }
}

async function serveWithDeadFacilitator(syncFacilitatorOnStart = true) {
  const cfg = loadConfig(baseEnv());
  const app = createApp(cfg, {
    now: () => NOW,
    ledger: new Ledger('/dev/null'),
    store: new FakeTapeStore(rows()),
    facilitatorClient: new DeadFacilitator(),
    syncFacilitatorOnStart,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    cfg,
    get: (path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: 'application/json' } }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('a facilitator outage is 503 with Retry-After, never a bare 500', async () => {
  const s = await serveWithDeadFacilitator();
  try {
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=1');
    assert.equal(res.status, 503, 'an outage on our payment rail is not a 500');
    assert.equal(res.headers.get('retry-after'), '30');
    const b = await res.json();
    assert.equal(b.error, 'payment_unavailable');
    assert.match(b.detail, /this is our payment rail, not your request/);
    assert.equal(b.facilitator, s.cfg.facilitatorUrl);
  } finally {
    await s.close();
  }
});

test('the outage answer is the same whether or not the boot time sync ran', async () => {
  const s = await serveWithDeadFacilitator(false);
  try {
    const res = await s.get('/v1/liquidations/window?symbol=SOL&hours=1');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'payment_unavailable');
  } finally {
    await s.close();
  }
});

test('during an outage the free surfaces still work, so the service stays discoverable', async () => {
  const s = await serveWithDeadFacilitator();
  try {
    assert.equal((await s.get('/health')).status, 200);
    const cat = await s.get('/catalog');
    assert.equal(cat.status, 200);
    assert.equal((await cat.json()).routes.length, CATALOG.length);
    assert.equal((await s.get('/.well-known/x402')).status, 200);
  } finally {
    await s.close();
  }
});

test('an outage never leaks the paid value', async () => {
  const s = await serveWithDeadFacilitator();
  try {
    const text = await (await s.get('/v1/liquidations/window?symbol=SOL&hours=1')).text();
    assert.equal(/3500/.test(text), false);
  } finally {
    await s.close();
  }
});

/**
 * The facilitator exactly as GoPlausible actually answers: Algorand advertised
 * with the untruncated 44 character genesis hash, Solana correctly truncated.
 * This reproduces the production failure that returned 503 instead of 402.
 */
class RealShapeFacilitator {
  constructor() {
    this.calls = { getSupported: 0 };
  }

  async getSupported() {
    this.calls.getSupported += 1;
    return {
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
        { x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
        { x402Version: 2, scheme: 'exact', network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' },
        { x402Version: 2, scheme: 'exact', network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' },
      ],
    };
  }

  async verify() {
    return { isValid: false, invalidReason: 'test facilitator never approves' };
  }

  async settle() {
    return { success: false, errorReason: 'test facilitator never settles' };
  }
}

test('the untruncated facilitator identifier still yields 402, not 503', async () => {
  const cfg = loadConfig(baseEnv());
  const app = createApp(cfg, {
    now: () => NOW,
    ledger: new Ledger('/dev/null'),
    store: new FakeTapeStore(rows()),
    facilitatorClient: new RealShapeFacilitator(),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/liquidations/window?symbol=SOL&hours=1`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(
      res.status,
      402,
      'a 503 here means the CAIP-2 reconciliation regressed and the paywall cannot challenge',
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('normalizeNetwork truncates Algorand and leaves other namespaces alone', async () => {
  const { normalizeNetwork } = await import('../src/x402.mjs');
  assert.equal(
    normalizeNetwork('algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='),
    'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe',
  );
  assert.equal(
    normalizeNetwork('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='),
    'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
  );
  assert.equal(normalizeNetwork('eip155:8453'), 'eip155:8453');
  assert.equal(normalizeNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(normalizeNetwork(null), null);
  assert.equal(normalizeNetwork('nonsense'), 'nonsense');
});

test('an already canonical identifier passes through unchanged', async () => {
  const { NormalizingFacilitatorClient } = await import('../src/x402.mjs');
  const inner = {
    async getSupported() {
      return { kinds: [{ scheme: 'exact', network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe' }] };
    },
    async verify() {},
    async settle() {},
  };
  const wrapped = new NormalizingFacilitatorClient(inner);
  const out = await wrapped.getSupported();
  assert.equal(out.kinds[0].network, 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe');
  assert.equal(wrapped.normalizedCount, 0, 'nothing was rewritten, so the counter stays at zero');
});

test('verify and settle pass straight through the wrapper', async () => {
  const { NormalizingFacilitatorClient } = await import('../src/x402.mjs');
  const seen = [];
  const inner = {
    async getSupported() { return { kinds: [] }; },
    async verify(a, b) { seen.push(['verify', a, b]); return { isValid: true }; },
    async settle(a, b) { seen.push(['settle', a, b]); return { success: true }; },
  };
  const wrapped = new NormalizingFacilitatorClient(inner);
  assert.deepEqual(await wrapped.verify('p', 'r'), { isValid: true });
  assert.deepEqual(await wrapped.settle('p', 'r'), { success: true });
  assert.deepEqual(seen.map((s) => s[0]), ['verify', 'settle']);
});
