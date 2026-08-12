import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ledger, EVENT, buildEntry, redact } from '../src/ledger.mjs';
import { preflight, probeFacilitator, collectKinds, SEVERITY, renderPreflight } from '../src/preflight.mjs';
import { buildRoutes, extractSettlement, routeIdForPath, SCHEME } from '../src/x402.mjs';
import { loadConfig } from '../src/config.mjs';
import { compileCatalog, CATALOG } from '../src/catalog.mjs';
import { baseEnv, VALID_ADDRESS, OTHER_ADDRESS, fakeFetch, jsonResponse } from './helpers.mjs';

async function tmpLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'af-algo-'));
  return new Ledger(join(dir, 'settlements.jsonl'));
}

const SUPPORTED_OK = (cfg) => jsonResponse(200, { kinds: [{ scheme: 'exact', network: cfg.caip2 }] });

test('a ledger entry refuses an unknown event rather than recording nonsense', () => {
  assert.throws(() => buildEntry({ event: 'maybe_paid' }), /unknown ledger event/);
});

test('secret shaped fields never reach a ledger line', () => {
  const r = redact({ authorization: 'Bearer abc', nested: { apiKey: 'sk_live_x', ok: 1 }, big: 5n });
  assert.equal(r.authorization, '[redacted]');
  assert.equal(r.nested.apiKey, '[redacted]');
  assert.equal(r.nested.ok, 1);
  assert.equal(r.big, '5');
});

test('settlements are appended and read back', async () => {
  const ledger = await tmpLedger();
  await ledger.record({ event: EVENT.SETTLED, payer: VALID_ADDRESS, amountMicro: 20000n, routeId: 'liquidation_window' });
  await ledger.record({ event: EVENT.VERIFY_FAILED, reason: 'bad signature' });
  const rows = await ledger.all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amountMicro, '20000');
  assert.equal(rows[1].event, 'verify_failed');
});

test('the summary leads with concentration, because a total alone is not a claim', async () => {
  const ledger = await tmpLedger();
  await ledger.record({ event: EVENT.SETTLED, payer: VALID_ADDRESS, amountMicro: 90000n, routeId: 'a' });
  await ledger.record({ event: EVENT.SETTLED, payer: OTHER_ADDRESS, amountMicro: 10000n, routeId: 'b' });
  const s = await ledger.summary();
  assert.equal(s.settlements, 2);
  assert.equal(s.distinctPayers, 2);
  assert.equal(s.totalMicro, '100000');
  assert.equal(s.largestPayerSharePct, 90);
  assert.match(s.concentrationNote, /90% of settled value/);
});

test('an empty ledger says so rather than reporting a hopeful zero', async () => {
  const ledger = await tmpLedger();
  const s = await ledger.summary();
  assert.equal(s.settlements, 0);
  assert.equal(s.largestPayerSharePct, 0);
  assert.match(s.concentrationNote, /no settlements recorded yet/);
});

test('a ledger write failure never propagates into the request path', async () => {
  const ledger = new Ledger('/this/path/does/not/exist/settlements.jsonl');
  await assert.doesNotReject(() => ledger.record({ event: EVENT.SETTLED }));
});

test('routes derive from the catalog with no price written twice', () => {
  const cfg = loadConfig(baseEnv());
  const compiled = compileCatalog();
  const routes = buildRoutes(compiled, cfg);

  assert.equal(Object.keys(routes).length, compiled.length);
  for (const entry of compiled) {
    const r = routes[entry.path];
    const [accept] = r.accepts;
    assert.equal(accept.scheme, SCHEME);
    assert.equal(accept.network, cfg.caip2);
    assert.equal(accept.payTo, cfg.payTo);
    assert.deepEqual(accept.price, { asset: cfg.usdcAsaId, amount: entry.micro.toString() });
    assert.equal(r.resource, `${cfg.baseUrl}${entry.path}`);
    assert.equal(r.description, entry.description);
  }
});

test('the unpaid preview tells an agent what it would buy without giving it away', () => {
  const cfg = loadConfig(baseEnv());
  const routes = buildRoutes(compileCatalog(), cfg);
  const preview = routes[CATALOG[0].path].unpaidResponseBody();
  assert.equal(preview.contentType, 'application/json');
  assert.equal(preview.body.price_usdc, CATALOG[0].price);
  assert.deepEqual(preview.body.response_status_vocabulary, ['measured', 'absent', 'unmeasured']);
  assert.equal(preview.body.value, undefined, 'the preview must not contain the paid value');
});

test('settlement extraction records the context shape when it cannot find a payer', () => {
  const found = extractSettlement({ somethingUnexpected: 1, alsoThis: 2 });
  assert.equal(found.payer, null);
  assert.deepEqual(found.shape, ['somethingUnexpected', 'alsoThis']);
});

test('settlement extraction reads the fields it does recognise', () => {
  const found = extractSettlement({
    settleResponse: { payer: VALID_ADDRESS, transaction: 'TX123' },
    paymentRequirements: { maxAmountRequired: '20000', asset: '10458941', network: 'algorand:x' },
  });
  assert.equal(found.payer, VALID_ADDRESS);
  assert.equal(found.txId, 'TX123');
  assert.equal(found.amountMicro, '20000');
  assert.equal(found.shape, undefined);
});

test('a path maps back to its catalog id, query string and all', () => {
  const compiled = compileCatalog();
  assert.equal(routeIdForPath(compiled, CATALOG[0].path), CATALOG[0].id);
  assert.equal(routeIdForPath(compiled, `${CATALOG[0].path}?symbol=SOL`), CATALOG[0].id);
  assert.equal(routeIdForPath(compiled, '/nope'), null);
  assert.equal(routeIdForPath(compiled, null), null);
});

test('preflight passes on a clean testnet config with a supportive facilitator', async () => {
  const cfg = loadConfig(baseEnv());
  const r = await preflight(cfg, { fetchImpl: fakeFetch(() => SUPPORTED_OK(cfg)) });
  assert.equal(r.ok, true);
  assert.equal(r.fatal, 0);
  assert.ok(r.checks.find((c) => c.name === 'pay_to').detail.includes('checksum verified'));
});

test('preflight warns about a missing tape rather than pretending', async () => {
  const cfg = loadConfig(baseEnv());
  const r = await preflight(cfg, { fetchImpl: fakeFetch(() => SUPPORTED_OK(cfg)) });
  const tape = r.checks.find((c) => c.name === 'tape');
  assert.equal(tape.severity, SEVERITY.WARN);
  assert.match(tape.detail, /bill nothing/);
});

test('a facilitator that does not support our network is fatal', async () => {
  const cfg = loadConfig(baseEnv());
  const wrong = jsonResponse(200, { kinds: [{ scheme: 'exact', network: 'eip155:8453' }] });
  const r = await preflight(cfg, { fetchImpl: fakeFetch(() => wrong) });
  assert.equal(r.ok, false);
  const f = r.checks.find((c) => c.name === 'facilitator');
  assert.equal(f.severity, SEVERITY.FAIL);
  assert.match(f.detail, /does not list scheme "exact"/);
  assert.match(f.detail, /eip155:8453/, 'says what it did list, so the gap is diagnosable');
});

test('an unreachable facilitator warns on testnet and fails on mainnet', async () => {
  const boom = fakeFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const testnet = loadConfig(baseEnv());
  assert.equal((await probeFacilitator(testnet, boom)).severity, SEVERITY.WARN);

  const mainnet = loadConfig(
    baseEnv({
      ALGO_NETWORK: 'mainnet',
      ALGO_ALLOW_MAINNET: 'yes',
      PUBLIC_BASE_URL: 'https://x402.ochinimus.app',
    }),
  );
  assert.equal((await probeFacilitator(mainnet, boom)).severity, SEVERITY.FAIL);
});

test('a facilitator HTTP error is reported with its status', async () => {
  const cfg = loadConfig(baseEnv());
  const r = await probeFacilitator(cfg, fakeFetch(() => jsonResponse(503, {})));
  assert.match(r.detail, /HTTP 503/);
});

test('an unrecognised supported shape warns rather than silently passing', async () => {
  const cfg = loadConfig(baseEnv());
  const r = await probeFacilitator(cfg, fakeFetch(() => jsonResponse(200, { something: 'else' })));
  assert.equal(r.severity, SEVERITY.WARN);
  assert.match(r.detail, /no supported kinds in a shape this build recognises/);
});

test('collectKinds accepts the plausible shapes and rejects junk', () => {
  assert.equal(collectKinds([{ network: 'a', scheme: 'exact' }]).length, 1);
  assert.equal(collectKinds({ kinds: [{ network: 'a' }] }).length, 1);
  assert.equal(collectKinds({ supported: ['a'] })[0].network, 'a');
  assert.equal(collectKinds({ data: [{ network: 'a' }] }).length, 1);
  assert.deepEqual(collectKinds(null), []);
  assert.deepEqual(collectKinds({ kinds: 'nope' }), []);
});

test('the rendered preflight names the fatal count so nobody scrolls past it', async () => {
  const cfg = loadConfig(baseEnv());
  const wrong = jsonResponse(200, { kinds: [{ scheme: 'exact', network: 'eip155:1' }] });
  const r = await preflight(cfg, { fetchImpl: fakeFetch(() => wrong) });
  const text = renderPreflight(r);
  assert.match(text, /FAIL/);
  assert.match(text, /refusing to start/);
});

test('the mainnet asset id is checked against the network, not assumed', async () => {
  const cfg = {
    ...loadConfig(baseEnv({ ALGO_NETWORK: 'mainnet', ALGO_ALLOW_MAINNET: 'yes', PUBLIC_BASE_URL: 'https://x.example' })),
    usdcAsaId: '10458941', // the testnet id, the classic copy paste
  };
  const r = await preflight(cfg, { fetchImpl: fakeFetch(() => SUPPORTED_OK(cfg)) });
  const asset = r.checks.find((c) => c.name === 'usdc_asset');
  assert.equal(asset.severity, SEVERITY.FAIL);
  assert.match(asset.detail, /is not the mainnet id 31566704/);
});

/**
 * The exact payload the live GoPlausible facilitator returned on 2026-08-05.
 * Captured verbatim rather than paraphrased, because the whole point of these
 * tests is the difference between what the docs imply and what the wire says.
 */
const LIVE_SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      extra: { feePayer: '8a8fFNfk2AGS7rgVv1BoqPUWnzQuoCrShJV8tSE6RAYi' },
    },
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
      extra: { feePayer: 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA' },
    },
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
      extra: { feePayer: 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA' },
    },
  ],
};

test('the config uses the exact identifier the facilitator validates against', async () => {
  const cfg = loadConfig(baseEnv());
  const advertised = LIVE_SUPPORTED.kinds.find((k) => k.network.startsWith('algorand:SGO1')).network;
  // This is the whole lesson. The truncated form passes core's local capability
  // check and is then rejected at verify time with "Network ... not supported".
  // The facilitator validates against the untruncated identifier, so that is
  // what the config has to carry.
  assert.equal(cfg.caip2, advertised);
  const r = await probeFacilitator(cfg, fakeFetch(() => jsonResponse(200, LIVE_SUPPORTED)));
  assert.equal(r.severity, SEVERITY.OK, `expected a match, got: ${r.detail}`);
});

test('the live facilitator payload is recognised on mainnet too', async () => {
  const cfg = loadConfig(
    baseEnv({ ALGO_NETWORK: 'mainnet', ALGO_ALLOW_MAINNET: 'yes', PUBLIC_BASE_URL: 'https://x.example' }),
  );
  const r = await probeFacilitator(cfg, fakeFetch(() => jsonResponse(200, LIVE_SUPPORTED)));
  assert.equal(r.severity, SEVERITY.OK, `expected a match, got: ${r.detail}`);
});

test('the truncated CAIP-2 form is NOT what we configure, because verify rejects it', async () => {
  const { normalizeCaip2 } = await import('../src/preflight.mjs');
  const cfg = loadConfig(baseEnv());
  const truncated = normalizeCaip2(cfg.caip2);
  assert.equal(truncated.split(':')[1].length, 32, 'CAIP-2 caps the reference at 32');
  assert.equal(cfg.caip2.split(':')[1].length, 44, 'the facilitator wants the full genesis hash');
  assert.notEqual(truncated, cfg.caip2);
  // normalizeCaip2 stays because the preflight compares defensively, but it is
  // no longer used to rewrite anything on the payment path.
  assert.equal(normalizeCaip2('eip155:8453'), 'eip155:8453');
});

test('normalising does not collapse genuinely different networks', async () => {
  const { normalizeCaip2 } = await import('../src/preflight.mjs');
  assert.notEqual(
    normalizeCaip2('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='),
    normalizeCaip2('algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='),
  );
  assert.equal(normalizeCaip2('eip155:8453'), 'eip155:8453');
  assert.equal(normalizeCaip2('nocolon'), null);
  assert.equal(normalizeCaip2(null), null);
});

test('a genuinely absent network is still fatal after normalising', async () => {
  const cfg = loadConfig(baseEnv());
  const evmOnly = { kinds: [{ scheme: 'exact', network: 'eip155:8453' }] };
  const r = await probeFacilitator(cfg, fakeFetch(() => jsonResponse(200, evmOnly)));
  assert.equal(r.severity, SEVERITY.FAIL);
});

test('the ledger recovers the route from requirements.resource, the key the live hook uses', () => {
  const cfg = loadConfig(baseEnv());
  const compiled = compileCatalog();
  const entry = compiled[0];
  // The shape observed live: requirements, not paymentRequirements.
  const found = extractSettlement({
    paymentPayload: {},
    requirements: { resource: `${cfg.baseUrl}${entry.path}`, maxAmountRequired: '20000', asset: '31566704' },
    result: { isValid: true, payer: VALID_ADDRESS },
  });
  assert.equal(found.payer, VALID_ADDRESS);
  assert.equal(found.amountMicro, '20000');
  assert.equal(routeIdForPath(compiled, `${cfg.baseUrl}${entry.path}`.slice(cfg.baseUrl.length)), entry.id);
});

test('a settled result yields the transaction id the ledger records', () => {
  const found = extractSettlement({
    requirements: { asset: '31566704' },
    result: { success: true, transaction: 'DCRT2S5UNR4OO7GINZS7NR6AHO6L6S7KXK2DAYAV4BV6C2HFLOYA', payer: VALID_ADDRESS },
  });
  assert.equal(found.txId, 'DCRT2S5UNR4OO7GINZS7NR6AHO6L6S7KXK2DAYAV4BV6C2HFLOYA');
  assert.equal(found.shape, undefined, 'a complete context needs no key dump');
});

test('every route carries the challenge tag, because it is a qualification condition', async () => {
  const { CHALLENGE_TAG } = await import('../src/catalog.mjs');
  const compiled = compileCatalog();
  assert.equal(CHALLENGE_TAG, 'x402-global-challenge');
  for (const e of compiled) {
    assert.ok(e.tags.includes(CHALLENGE_TAG), `${e.id} is missing the challenge tag`);
  }
});

/**
 * Where the tag lives is not cosmetic. The Global x402 Challenge leaderboard
 * filters on accepts[].extra.tag, not on resource.tags. Confirmed by the
 * Algorand Foundation on 2026-08-11, after six mainnet settlements went
 * unattributed because the tag was only ever on the resource. ExactAvmScheme
 * merges extra rather than replacing it, so feePayer survives alongside.
 */
test('the challenge tag rides in accepts.extra, which is where the leaderboard reads it', async () => {
  const { CHALLENGE_TAG } = await import('../src/catalog.mjs');
  const cfg = loadConfig(baseEnv());
  const routes = buildRoutes(compileCatalog(), cfg);
  assert.ok(Object.keys(routes).length > 0);
  for (const [path, r] of Object.entries(routes)) {
    assert.ok(r.tags.includes(CHALLENGE_TAG), `${path} lost the tag on resource.tags`);
    assert.ok(r.accepts.length > 0, `${path} has no payment options`);
    for (const accept of r.accepts) {
      assert.equal(
        accept.extra?.tag,
        CHALLENGE_TAG,
        `${path} does not carry the challenge tag in accepts.extra; the leaderboard will not attribute its settlements`,
      );
    }
  }
});

test('the tag is added once, not duplicated when an entry already declares it', async () => {
  const { CHALLENGE_TAG } = await import('../src/catalog.mjs');
  const [first] = compileCatalog([{ ...CATALOG[0], tags: ['derivatives', CHALLENGE_TAG] }]);
  assert.equal(first.tags.filter((t) => t === CHALLENGE_TAG).length, 1);
});

test('every route declares Bazaar discovery, and core agrees it is needed', async () => {
  const { checkIfBazaarNeeded } = await import('@x402/core/server');
  const cfg = loadConfig(baseEnv());
  const routes = buildRoutes(compileCatalog(), cfg);
  assert.equal(checkIfBazaarNeeded(routes), true, 'without this the endpoint is not discoverable');
  for (const [path, r] of Object.entries(routes)) {
    assert.ok(r.extensions?.bazaar, `${path} has no bazaar extension`);
    assert.ok(r.extensions.bazaar.info, `${path} bazaar extension has no info`);
    assert.ok(r.extensions.bazaar.schema, `${path} bazaar extension has no schema`);
    assert.equal(r.extensions.bazaar.info.input.method, 'GET');
  }
});

test('the declared discovery input matches the query parameters the route documents', () => {
  const cfg = loadConfig(baseEnv());
  const compiled = compileCatalog();
  const routes = buildRoutes(compiled, cfg);
  const window = compiled.find((e) => e.id === 'liquidation_window');
  const declared = routes[window.path].extensions.bazaar.info.input.queryParams;
  assert.deepEqual(Object.keys(declared).sort(), ['hours', 'symbol']);
  for (const key of Object.keys(declared)) {
    assert.match(window.query, new RegExp(key), `${key} is declared but not documented in query`);
  }
});
