import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toMicroUsdc, fromMicroUsdc, priceFor, sumMicro, USDC_DECIMALS } from '../src/money.mjs';
import { validateAlgorandAddress, isValidAlgorandAddress, base32Decode } from '../src/address.mjs';
import { VALID_ADDRESS, makeAddress } from './helpers.mjs';

test('USDC has six decimals and prices convert exactly', () => {
  assert.equal(USDC_DECIMALS, 6);
  assert.equal(toMicroUsdc('0.02'), 20000n);
  assert.equal(toMicroUsdc('1'), 1000000n);
  assert.equal(toMicroUsdc('0.000001'), 1n);
  assert.equal(toMicroUsdc('123.456789'), 123456789n);
});

test('a float literal converts to what was written, not its binary artifact', () => {
  assert.equal(toMicroUsdc(0.02), 20000n);
  assert.equal(toMicroUsdc(0.1), 100000n);
});

test('more precision than USDC can express is refused, never truncated', () => {
  assert.throws(() => toMicroUsdc('0.0000001'), /refusing to truncate/);
  assert.throws(() => toMicroUsdc('1.1234567'), /refusing to truncate/);
});

test('exponent notation, signs and junk are refused', () => {
  assert.throws(() => toMicroUsdc('1e6'), /plain non-negative decimal/);
  assert.throws(() => toMicroUsdc('-1'), /plain non-negative decimal/);
  assert.throws(() => toMicroUsdc(''), /empty price/);
  assert.throws(() => toMicroUsdc(NaN), /not finite/);
  assert.throws(() => toMicroUsdc(1e-7), /pass it as a string/);
});

test('a BigInt passes through and a negative one does not', () => {
  assert.equal(toMicroUsdc(20000n), 20000n);
  assert.throws(() => toMicroUsdc(-1n), /cannot be negative/);
});

test('rendering back is exact and drops no significant digits', () => {
  assert.equal(fromMicroUsdc(20000n), '0.02');
  assert.equal(fromMicroUsdc(1n), '0.000001');
  assert.equal(fromMicroUsdc(1000000n), '1');
  assert.equal(fromMicroUsdc(123456789n), '123.456789');
  assert.equal(fromMicroUsdc(0n), '0');
});

test('every price round trips through both directions', () => {
  for (const p of ['0.000001', '0.02', '0.05', '0.1', '1', '99.999999']) {
    assert.equal(fromMicroUsdc(toMicroUsdc(p)), String(Number(p)), `round trip failed for ${p}`);
  }
});

test('priceFor emits the asset amount shape x402 expects', () => {
  assert.deepEqual(priceFor(20000n, '31566704'), { asset: '31566704', amount: '20000' });
});

test('a zero price is refused because a free route is a different thing', () => {
  assert.throws(() => priceFor(0n, '31566704'), /must cost more than zero/);
});

test('a non numeric asset id is refused', () => {
  assert.throws(() => priceFor(1n, 'USDC'), /must be numeric/);
});

test('summing prices never touches a float', () => {
  assert.equal(sumMicro([20000n, 50000n, 100000n, 30000n]), 200000n);
  assert.equal(fromMicroUsdc(sumMicro([20000n, 50000n, 100000n, 30000n])), '0.2');
});

test('a generated address validates, proving the checksum path end to end', () => {
  assert.equal(isValidAlgorandAddress(VALID_ADDRESS), true);
  assert.equal(VALID_ADDRESS.length, 58);
});

test('a transposed pair fails the checksum, which a regex would not catch', () => {
  const a = VALID_ADDRESS;
  const swapped = a.slice(0, 10) + a[11] + a[10] + a.slice(12);
  assert.notEqual(swapped, a, 'the two characters must actually differ for this test to mean anything');
  const r = validateAlgorandAddress(swapped);
  assert.equal(r.valid, false);
  assert.match(r.reason, /checksum/);
});

test('length, case and alphabet each fail with their own reason', () => {
  assert.match(validateAlgorandAddress(VALID_ADDRESS.slice(0, 57)).reason, /58 characters/);
  assert.match(validateAlgorandAddress(VALID_ADDRESS.toLowerCase()).reason, /uppercase/);
  assert.match(validateAlgorandAddress(`0${VALID_ADDRESS.slice(1)}`).reason, /base32 alphabet/);
  assert.match(validateAlgorandAddress(null).reason, /expected a string/);
});

test('two different seeds give two different valid addresses', () => {
  const a = makeAddress(1);
  const b = makeAddress(2);
  assert.notEqual(a, b);
  assert.equal(isValidAlgorandAddress(a), true);
  assert.equal(isValidAlgorandAddress(b), true);
});

test('base32Decode rejects an invalid character rather than guessing', () => {
  assert.equal(base32Decode('AAAA1'), null);
  assert.ok(base32Decode('AAAA') instanceof Uint8Array);
});
