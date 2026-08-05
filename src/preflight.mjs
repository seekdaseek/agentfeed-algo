/**
 * Preflight.
 *
 * The list of things that must be true before this service is allowed to take
 * real money, checked in one place and before anything is listening.
 *
 * The order matters. Local checks run first because they are free and because a
 * misconfigured payTo should be caught without a network round trip. Only once
 * the local picture is coherent do we ask the facilitator whether it actually
 * supports the network and scheme we intend to charge on.
 *
 * A failure here is not a warning to be scrolled past. On mainnet the process
 * refuses to start.
 */

import { validateAlgorandAddress } from './address.mjs';
import { compileCatalog, sweepPrice, FREE_ROUTES } from './catalog.mjs';
import { fromMicroUsdc } from './money.mjs';
import { NETWORKS } from './config.mjs';
import { SCHEME } from './x402.mjs';

export const SEVERITY = Object.freeze({ FAIL: 'fail', WARN: 'warn', OK: 'ok' });

/**
 * Run every check. Never throws on a bad configuration; returns findings, so
 * the caller decides what a failure means. The CLI treats fail as fatal.
 *
 * @param {object} cfg
 * @param {(url: string, init?: object) => Promise<Response>} fetchImpl
 */
export async function preflight(cfg, { fetchImpl = globalThis.fetch, catalog = undefined } = {}) {
  const checks = [];
  const add = (name, severity, detail) => checks.push({ name, severity, detail });

  // --- local, free, and first ---

  const net = NETWORKS[cfg.networkName];
  if (!net) {
    add('network', SEVERITY.FAIL, `unknown network "${cfg.networkName}"`);
  } else if (net.caip2 !== cfg.caip2) {
    add('network', SEVERITY.FAIL, `caip2 ${cfg.caip2} does not match ${cfg.networkName}`);
  } else {
    add('network', SEVERITY.OK, `${cfg.networkName} (${cfg.caip2})`);
  }

  // The asset id is the field where a copy paste between networks is invisible
  // until somebody pays in the wrong token.
  if (net && cfg.usdcAsaId !== net.usdcAsaId) {
    add(
      'usdc_asset',
      SEVERITY.FAIL,
      `USDC asset id ${cfg.usdcAsaId} is not the ${cfg.networkName} id ${net.usdcAsaId}`,
    );
  } else if (net) {
    add('usdc_asset', SEVERITY.OK, `USDC ASA ${cfg.usdcAsaId} on ${cfg.networkName}`);
  }

  const addr = validateAlgorandAddress(cfg.payTo);
  add(
    'pay_to',
    addr.valid ? SEVERITY.OK : SEVERITY.FAIL,
    addr.valid ? `${cfg.payTo} (checksum verified)` : addr.reason,
  );

  let compiled = [];
  try {
    compiled = compileCatalog(catalog);
    add(
      'catalog',
      SEVERITY.OK,
      `${compiled.length} paid routes, every route once costs ${fromMicroUsdc(sweepPrice(compiled))} USDC`,
    );
  } catch (err) {
    add('catalog', SEVERITY.FAIL, err.message);
  }

  for (const entry of compiled) {
    if (FREE_ROUTES.includes(entry.path)) {
      add('route_collision', SEVERITY.FAIL, `${entry.path} is both paid and free`);
    }
  }

  if (!cfg.isTestnet) {
    if (/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
      add('base_url', SEVERITY.FAIL, `mainnet resource URL points at localhost: ${cfg.baseUrl}`);
    } else if (!cfg.baseUrl.startsWith('https://')) {
      add('base_url', SEVERITY.WARN, `mainnet resource URL is not https: ${cfg.baseUrl}`);
    } else {
      add('base_url', SEVERITY.OK, cfg.baseUrl);
    }
  } else {
    add('base_url', SEVERITY.OK, cfg.baseUrl);
  }

  if (!cfg.tapePath) {
    add(
      'tape',
      SEVERITY.WARN,
      'no TAPE_PATH configured, so data routes will answer unmeasured and bill nothing',
    );
  } else {
    add('tape', SEVERITY.OK, cfg.tapePath);
  }

  // --- remote, last, and only once the above makes sense ---

  const supported = await probeFacilitator(cfg, fetchImpl);
  checks.push(supported);

  const failed = checks.filter((c) => c.severity === SEVERITY.FAIL);
  const warned = checks.filter((c) => c.severity === SEVERITY.WARN);

  return {
    ok: failed.length === 0,
    fatal: failed.length,
    warnings: warned.length,
    checks,
    compiled,
  };
}

/**
 * Ask the facilitator what it supports and confirm our network and scheme are
 * in the answer. An unreachable facilitator is a warning on testnet and a
 * failure on mainnet, because on mainnet it is the thing that settles money.
 */
export async function probeFacilitator(cfg, fetchImpl) {
  const url = `${cfg.facilitatorUrl}/supported`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(cfg.facilitatorTimeoutMs) : undefined,
    });
    if (!res.ok) {
      return {
        name: 'facilitator',
        severity: cfg.isTestnet ? SEVERITY.WARN : SEVERITY.FAIL,
        detail: `${url} returned HTTP ${res.status}`,
      };
    }
    const body = await res.json().catch(() => null);
    const kinds = collectKinds(body);
    if (kinds.length === 0) {
      return {
        name: 'facilitator',
        severity: SEVERITY.WARN,
        detail: `${url} responded but listed no supported kinds in a shape this build recognises`,
      };
    }
    const want = normalizeCaip2(cfg.caip2);
    const match = kinds.find(
      (k) => normalizeCaip2(k.network) === want && (k.scheme === undefined || k.scheme === SCHEME),
    );
    if (!match) {
      return {
        name: 'facilitator',
        severity: SEVERITY.FAIL,
        detail:
          `${url} does not list scheme "${SCHEME}" on ${cfg.caip2}. ` +
          `It listed: ${kinds.map((k) => `${k.scheme ?? '?'}@${k.network}`).join(', ')}`,
      };
    }
    return { name: 'facilitator', severity: SEVERITY.OK, detail: `${url} supports ${SCHEME} on ${cfg.caip2}` };
  } catch (err) {
    return {
      name: 'facilitator',
      severity: cfg.isTestnet ? SEVERITY.WARN : SEVERITY.FAIL,
      detail: `${url} unreachable: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * Normalise a CAIP-2 identifier before comparing.
 *
 * CAIP-2 caps the reference at 32 characters. The @x402/avm package constants
 * follow that. The GoPlausible facilitator advertises Algorand with the full
 * 44 character base64 genesis hash instead, padding included, while advertising
 * Solana correctly truncated in the very same response.
 *
 * Comparing those two forms with === produces a false negative that reads as
 * "the facilitator does not support your network", which on mainnet would stop
 * this service from starting for a reason that is not real. Observed live on
 * 2026-08-05; verify again if the facilitator changes.
 */
export function normalizeCaip2(id) {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(':');
  if (i === -1) return null;
  return `${id.slice(0, i)}:${id.slice(i + 1).replace(/=+$/, '').slice(0, 32)}`;
}

/** Accept several plausible shapes rather than assuming one we have not seen live. */
export function collectKinds(body) {
  if (!body || typeof body !== 'object') return [];
  const list = Array.isArray(body) ? body : (body.kinds ?? body.supported ?? body.data ?? []);
  if (!Array.isArray(list)) return [];
  return list
    .map((k) => (typeof k === 'string' ? { network: k } : { network: k?.network, scheme: k?.scheme }))
    .filter((k) => typeof k.network === 'string');
}

/** One line per check, aligned, for a terminal. */
export function renderPreflight(result) {
  const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };
  const lines = result.checks.map(
    (c) => `  ${mark[c.severity]}  ${c.name.padEnd(16)} ${c.detail}`,
  );
  lines.push(
    result.ok
      ? `\n  ready${result.warnings ? ` with ${result.warnings} warning(s)` : ''}`
      : `\n  ${result.fatal} fatal problem(s); refusing to start`,
  );
  return lines.join('\n');
}
