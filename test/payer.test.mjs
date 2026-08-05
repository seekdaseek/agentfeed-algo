import { test } from 'node:test';
import assert from 'node:assert/strict';
import algosdk from 'algosdk';

import { signerFromMnemonic, payerReadiness, PayerError, ALGORAND_WILDCARD } from '../src/payer.mjs';

/** A throwaway account, generated per run. No real key ever appears in this file. */
function throwaway() {
  const acct = algosdk.generateAccount();
  return { addr: acct.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(acct.sk) };
}

function fakeAlgorand(info) {
  return {
    account: {
      async getInformation() {
        if (info instanceof Error) throw info;
        return info;
      },
    },
  };
}

test('a mnemonic derives the same address it was generated from', () => {
  const t = throwaway();
  const out = signerFromMnemonic(t.mnemonic);
  assert.equal(out.address, t.addr);
});

test('the derived signer exposes an address and a signing function, and nothing else secret', () => {
  const out = signerFromMnemonic(throwaway().mnemonic);
  assert.equal(typeof out.signer.address, 'string');
  assert.equal(typeof out.signer.signTransactions, 'function');
  assert.equal('sk' in out, false, 'the secret key must not be returned to the caller');
  assert.equal('mnemonic' in out, false);
});

test('a wrong length mnemonic is refused before anything is decoded', () => {
  assert.throws(() => signerFromMnemonic('one two three'), PayerError);
  assert.throws(() => signerFromMnemonic(''), /25 words/);
  assert.throws(() => signerFromMnemonic(null), /25 words/);
});

test('twenty five words that are not a real mnemonic are refused too', () => {
  assert.throws(() => signerFromMnemonic(Array(25).fill('zzzz').join(' ')), PayerError);
});

test('an account that does not exist on chain is diagnosed, not thrown', async () => {
  const r = await payerReadiness(fakeAlgorand(new Error('account not found')), 'ADDR', '10458941', 20000n);
  assert.equal(r.ready, false);
  assert.match(r.problems[0], /has never been funded does not exist on chain yet/);
});

test('not being opted in is named as the specific problem, with the cost of fixing it', async () => {
  const r = await payerReadiness(
    fakeAlgorand({ balance: { microAlgo: 1_000_000 }, assets: [] }),
    'ADDR',
    '10458941',
    20000n,
  );
  assert.equal(r.ready, false);
  assert.match(r.problems[0], /not opted in to asset 10458941/);
  assert.match(r.problems[0], /0\.1 ALGO/);
  assert.equal(r.microUsdc, null, 'no holding means no balance to report, not a zero');
});

test('holding too little USDC is reported with both numbers', async () => {
  const r = await payerReadiness(
    fakeAlgorand({ balance: { microAlgo: 1_000_000 }, assets: [{ assetId: '10458941', amount: 5000 }] }),
    'ADDR',
    '10458941',
    20000n,
  );
  assert.equal(r.ready, false);
  assert.match(r.problems[0], /holds 0\.005 USDC but the call costs 0\.02/);
});

test('a funded and opted in account is ready', async () => {
  const r = await payerReadiness(
    fakeAlgorand({ balance: { microAlgo: 2_000_000 }, assets: [{ assetId: '10458941', amount: 1_000_000 }] }),
    'ADDR',
    '10458941',
    20000n,
  );
  assert.equal(r.ready, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.microUsdc, 1_000_000n);
  assert.equal(r.algoMicro, 2_000_000n);
});

test('zero ALGO is flagged even when the asset holding exists', async () => {
  const r = await payerReadiness(
    fakeAlgorand({ balance: { microAlgo: 0 }, assets: [{ assetId: '10458941', amount: 1_000_000 }] }),
    'ADDR',
    '10458941',
    20000n,
  );
  assert.equal(r.ready, false);
  assert.match(r.problems[0], /holds no ALGO/);
});

test('the hyphenated asset-id shape from the algod REST API is also understood', async () => {
  const r = await payerReadiness(
    fakeAlgorand({ balance: { microAlgo: 1_000_000 }, assets: [{ 'asset-id': '10458941', amount: 50_000 }] }),
    'ADDR',
    '10458941',
    20000n,
  );
  assert.equal(r.ready, true);
  assert.equal(r.microUsdc, 50_000n);
});

test('the scheme registers under the Algorand namespace wildcard', () => {
  assert.equal(ALGORAND_WILDCARD, 'algorand:*');
});
