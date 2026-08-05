/**
 * Algorand address validation.
 *
 * An Algorand address is the base32 encoding, without padding, of a 32 byte
 * public key followed by a 4 byte checksum. The checksum is the last 4 bytes of
 * the SHA-512/256 digest of the public key. That makes the whole thing 58
 * characters.
 *
 * This is implemented here rather than pulled from a library for one reason:
 * the payTo address is the single field where a typo costs real money silently.
 * A regex that only checks length and alphabet will happily accept a
 * transposed pair of characters. The checksum will not. Six lines of base32 is
 * a fair price for catching that before mainnet does.
 */

import { createHash } from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const ALGORAND_ADDRESS_LENGTH = 58;
const PUBLIC_KEY_BYTES = 32;
const CHECKSUM_BYTES = 4;

/** Decode unpadded RFC 4648 base32. Returns null on any invalid character. */
export function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of input) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Validate an Algorand address end to end.
 *
 * Returns { valid, reason }. A reason is always present when invalid, because
 * "invalid address" on its own tells an operator nothing about which of the
 * four possible mistakes they made.
 */
export function validateAlgorandAddress(address) {
  if (typeof address !== 'string') {
    return { valid: false, reason: `expected a string, got ${typeof address}` };
  }
  const a = address.trim();
  if (a.length !== ALGORAND_ADDRESS_LENGTH) {
    return {
      valid: false,
      reason: `expected ${ALGORAND_ADDRESS_LENGTH} characters, got ${a.length}`,
    };
  }
  if (a !== a.toUpperCase()) {
    return { valid: false, reason: 'Algorand addresses are uppercase base32' };
  }

  const decoded = base32Decode(a);
  if (decoded === null) {
    return { valid: false, reason: 'contains a character outside the base32 alphabet A-Z and 2-7' };
  }
  if (decoded.length < PUBLIC_KEY_BYTES + CHECKSUM_BYTES) {
    return { valid: false, reason: `decoded to ${decoded.length} bytes, expected at least 36` };
  }

  const publicKey = decoded.subarray(0, PUBLIC_KEY_BYTES);
  const checksum = decoded.subarray(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + CHECKSUM_BYTES);
  const expected = createHash('sha512-256')
    .update(Buffer.from(publicKey))
    .digest()
    .subarray(-CHECKSUM_BYTES);

  if (!Buffer.from(checksum).equals(expected)) {
    return {
      valid: false,
      reason: 'checksum does not match, which usually means a mistyped or transposed character',
    };
  }
  return { valid: true, reason: null };
}

export function isValidAlgorandAddress(address) {
  return validateAlgorandAddress(address).valid;
}
