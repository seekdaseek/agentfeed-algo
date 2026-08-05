/**
 * Money.
 *
 * USDC on Algorand is an ASA with 6 decimals. Every price in this service is
 * held as a BigInt count of microUSDC and never as a float.
 *
 * The reason is narrow and specific. x402's PaymentOption.price accepts a
 * string or a number, and the AVM package's own convertToTokenAmount returns a
 * JavaScript number. For a two cent call that is harmless. For anything larger,
 * or for any arithmetic done before handing the value over, a float is a way to
 * charge a different amount than the one you published. This module refuses to
 * be the place that happens.
 *
 * Rounding is not a rounding strategy here. A price with more precision than
 * the asset can express is an error, not something to silently shorten.
 */

export const USDC_DECIMALS = 6;

/**
 * Parse a human readable USDC amount into microUSDC.
 *
 * Accepts "0.02", "1", "0.000001", 0.02, or a BigInt already in base units.
 * Rejects exponent notation, signs, empty strings and anything with more than
 * six decimal places.
 */
export function toMicroUsdc(amount, decimals = USDC_DECIMALS) {
  if (typeof amount === 'bigint') {
    if (amount < 0n) throw new RangeError('price cannot be negative');
    return amount;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals out of range: ${decimals}`);
  }

  let s;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) throw new TypeError(`price is not finite: ${amount}`);
    s = String(amount);
    if (/e/i.test(s)) {
      throw new TypeError(
        `price ${s} is outside the range JavaScript prints as a plain decimal; pass it as a string`,
      );
    }
  } else {
    s = String(amount ?? '').trim();
  }

  if (s === '') throw new TypeError('empty price');
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new TypeError(`price "${s}" is not a plain non-negative decimal`);
  }

  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new RangeError(
      `price "${s}" has ${frac.length} decimal places but USDC has ${decimals}; refusing to truncate`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/** Render microUSDC back to a human string, exactly, with no trailing noise. */
export function fromMicroUsdc(micro, decimals = USDC_DECIMALS) {
  const v = BigInt(micro);
  if (v < 0n) throw new RangeError('amount cannot be negative');
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/**
 * The value handed to x402 as PaymentOption.price.
 *
 * We pass the AssetAmount form rather than a Money string, because the
 * AssetAmount carries the asset id explicitly and its `amount` is a string of
 * base units. That removes every opportunity for a decimal to be interpreted
 * against the wrong asset.
 */
export function priceFor(micro, asaId) {
  const v = BigInt(micro);
  if (v <= 0n) throw new RangeError('a paid route must cost more than zero');
  if (!/^\d+$/.test(String(asaId))) throw new TypeError(`asset id must be numeric, got "${asaId}"`);
  return { asset: String(asaId), amount: v.toString() };
}

/** Sum a list of microUSDC values without ever touching a float. */
export function sumMicro(values) {
  return values.reduce((acc, v) => acc + BigInt(v), 0n);
}
