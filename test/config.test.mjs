import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, ConfigError, MAINNET_CAIP2, TESTNET_CAIP2, USDC_ASA } from '../src/config.mjs';
import { compileCatalog, sweepPrice, CatalogError, CATALOG, FREE_ROUTES } from '../src/catalog.mjs';
import { fromMicroUsdc } from '../src/money.mjs';
import { measured, absent, unmeasured, isBillable, forWire } from '../src/envelope.mjs';
import { baseEnv, VALID_ADDRESS } from './helpers.mjs';

test('a clean testnet config builds and is frozen', () => {
  const cfg = loadConfig(baseEnv());
  assert.equal(cfg.networkName, 'testnet');
  assert.equal(cfg.caip2, TESTNET_CAIP2);
  assert.equal(cfg.usdcAsaId, USDC_ASA.testnet);
  assert.equal(cfg.isTestnet, true);
  assert.throws(() => {
    'use strict';
    cfg.payTo = 'x';
  });
});

test('testnet is the default, so an unset network never means mainnet', () => {
  const env = baseEnv();
  delete env.ALGO_NETWORK;
  assert.equal(loadConfig(env).networkName, 'testnet');
});

test('mainnet requires a second explicit acknowledgement', () => {
  const env = baseEnv({ ALGO_NETWORK: 'mainnet', PUBLIC_BASE_URL: 'https://x402.ochinimus.app' });
  assert.throws(() => loadConfig(env), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.problems.some((p) => /ALGO_ALLOW_MAINNET/.test(p)));
    return true;
  });

  const ok = loadConfig({ ...env, ALGO_ALLOW_MAINNET: 'yes' });
  assert.equal(ok.caip2, MAINNET_CAIP2);
  assert.equal(ok.usdcAsaId, USDC_ASA.mainnet);
  assert.equal(ok.isTestnet, false);
});

test('mainnet refuses a localhost resource URL', () => {
  const env = baseEnv({ ALGO_NETWORK: 'mainnet', ALGO_ALLOW_MAINNET: 'yes' });
  assert.throws(() => loadConfig(env), /localhost/);
});

test('mainnet refuses a plaintext facilitator', () => {
  const env = baseEnv({
    ALGO_NETWORK: 'mainnet',
    ALGO_ALLOW_MAINNET: 'yes',
    PUBLIC_BASE_URL: 'https://x402.ochinimus.app',
    X402_FACILITATOR_URL: 'http://facilitator.example',
  });
  assert.throws(() => loadConfig(env), /plaintext http facilitator/);
});

test('a bad payTo is rejected with the checksum reason, not a generic message', () => {
  const env = baseEnv({ ALGO_PAY_TO: `${VALID_ADDRESS.slice(0, 57)}A` });
  assert.throws(() => loadConfig(env), /ALGO_PAY_TO is not a valid Algorand address/);
});

test('a missing payTo is named as required', () => {
  const env = baseEnv();
  delete env.ALGO_PAY_TO;
  assert.throws(() => loadConfig(env), /ALGO_PAY_TO is required/);
});

test('every problem is reported at once, not one per run', () => {
  try {
    loadConfig({ ALGO_NETWORK: 'nope', PORT: '0' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.problems.length >= 3, `expected several problems, got ${err.problems.length}`);
  }
});

test('the shipped catalog compiles and totals what the CLI prints', () => {
  const compiled = compileCatalog();
  assert.equal(compiled.length, CATALOG.length);
  assert.equal(fromMicroUsdc(sweepPrice(compiled)), '0.2');
  for (const e of compiled) assert.ok(e.micro > 0n);
});

test('catalog entries are frozen so a route cannot be repriced at runtime', () => {
  const [first] = compileCatalog();
  assert.throws(() => {
    'use strict';
    first.micro = 1n;
  });
});

test('a duplicate id or path is a build error', () => {
  const dupId = [CATALOG[0], { ...CATALOG[1], id: CATALOG[0].id }];
  assert.throws(() => compileCatalog(dupId), /duplicate catalog id/);

  const dupPath = [CATALOG[0], { ...CATALOG[1], path: CATALOG[0].path }];
  assert.throws(() => compileCatalog(dupPath), /duplicate catalog path/);
});

test('a paid route may not collide with a free one', () => {
  assert.throws(
    () => compileCatalog([{ ...CATALOG[0], path: FREE_ROUTES[1] }]),
    /collides with a free route/,
  );
});

test('a zero or unparseable price is a build error', () => {
  assert.throws(() => compileCatalog([{ ...CATALOG[0], price: '0' }]), /priced at zero/);
  assert.throws(() => compileCatalog([{ ...CATALOG[0], price: '0.0000001' }]), /unusable price/);
});

test('an entry missing a field, tags or a sane id is refused', () => {
  assert.throws(() => compileCatalog([{ ...CATALOG[0], description: '' }]), /missing "description"/);
  assert.throws(() => compileCatalog([{ ...CATALOG[0], tags: [] }]), /at least one tag/);
  assert.throws(() => compileCatalog([{ ...CATALOG[0], id: 'Not-Snake' }]), /lower snake case/);
  assert.throws(() => compileCatalog([{ ...CATALOG[0], path: 'v1/x' }]), /must start with \//);
  assert.throws(() => compileCatalog([]), /catalog is empty/);
});

test('measured refuses the values that are really absences', () => {
  assert.throws(() => measured(null), /needs a value/);
  assert.throws(() => measured(undefined), /needs a value/);
  assert.throws(() => measured(NaN), /non-finite/);
  assert.equal(measured(0).value, 0, 'zero is a measurement');
});

test('billing follows the status, and only unmeasured is unbillable', () => {
  assert.equal(isBillable(measured(1)), true);
  assert.equal(isBillable(absent()), true);
  assert.equal(isBillable(unmeasured({ basis: 'upstream 429' })), false);
});

test('the wire form carries the disclosure that makes the status readable', () => {
  const w = forWire(measured(5, { asOf: 1, source: 's' }), { route: 'r', network: 'n' });
  assert.equal(w.status, 'measured');
  assert.equal(w.route, 'r');
  assert.match(w.disclosure, /never billed/);
});

test('envelopes are frozen', () => {
  const e = measured(1);
  assert.throws(() => {
    'use strict';
    e.value = 2;
  });
});
