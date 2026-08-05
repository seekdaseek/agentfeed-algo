/**
 * The response envelope.
 *
 * Every paid response from this service carries its own status. A buyer who
 * pays for a number is entitled to know whether it was observed, whether the
 * market genuinely had nothing to say, or whether our pipe broke.
 *
 *   measured    we asked, we got an answer
 *   absent      we asked, the answer was none, which is itself a finding
 *   unmeasured  we asked, our own side failed, and this is not a finding
 *
 * The commercial argument for this is simple. Once an agent is paying per call,
 * the worst possible product is one that charges for a zero it invented. A feed
 * that says when it does not know is worth more per call than one that always
 * answers, because the caller can act on the difference.
 *
 * The billing rule that follows: an unmeasured response is not billable. The
 * service returns 503 before the paywall rather than taking money for a hole.
 */

export const MEASURED = 'measured';
export const ABSENT = 'absent';
export const UNMEASURED = 'unmeasured';

export function measured(value, { asOf, basis, source, control } = {}) {
  if (value === null || value === undefined) {
    throw new TypeError('measured() needs a value; use absent() or unmeasured()');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`measured() got a non-finite number: ${value}`);
  }
  return envelope(MEASURED, value, { asOf, basis, source, control });
}

export function absent({ asOf, basis, source, control } = {}) {
  return envelope(ABSENT, null, { asOf, basis, source, control });
}

export function unmeasured({ basis, source, failure } = {}) {
  return envelope(UNMEASURED, null, { basis, source, failure });
}

function envelope(status, value, extra) {
  const out = {
    status,
    value,
    asOf: extra.asOf ?? null,
    basis: extra.basis ?? null,
    source: extra.source ?? null,
  };
  if (extra.control !== undefined) out.control = extra.control;
  if (extra.failure !== undefined) out.failure = extra.failure;
  return Object.freeze(out);
}

/** Billable means we actually delivered something the buyer can use. */
export function isBillable(env) {
  return env?.status === MEASURED || env?.status === ABSENT;
}

/**
 * Wrap an envelope for the wire, adding the disclosure that makes the status
 * meaningful to somebody reading the JSON for the first time.
 */
export function forWire(env, { route, network } = {}) {
  return {
    ...env,
    route: route ?? null,
    network: network ?? null,
    disclosure:
      'status is one of measured, absent or unmeasured. absent means the market had no value ' +
      'to give and is a real finding. unmeasured means our own lookup failed and is not a ' +
      'finding; those responses are never billed.',
  };
}
