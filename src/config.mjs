/**
 * Configuration.
 *
 * Two rules shape this file.
 *
 * Mainnet is never a default. Selecting the network that moves real money has
 * to be a thing somebody typed, and typed twice: once to name the network and
 * once to acknowledge it. A service that quietly falls back to mainnet because
 * an environment variable was unset is a service that will one day take
 * payments to an address nobody checked.
 *
 * Nothing here is lazily validated. The config either builds completely or
 * throws at startup. Half a config that fails on the first paid request is
 * worse than no config at all, because by then an agent is already waiting.
 */

import { validateAlgorandAddress } from './address.mjs';

/**
 * The network identifiers the FACILITATOR accepts.
 *
 * CAIP-2 caps a chain reference at 32 characters and @x402/avm's exported
 * constants follow that, but the GoPlausible facilitator both advertises and
 * validates against the full 44 character base64 genesis hash, padding
 * included. Using the truncated form gets you a clean local capability check
 * and then a rejection at verify time reading "Network algorand:... not
 * supported", which is the worst possible place to find out.
 *
 * These are the strings that have to match, because these are the strings the
 * money is checked against. Observed live on 2026-08-05.
 */
export const MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
export const TESTNET_CAIP2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';

export const USDC_ASA = Object.freeze({
  mainnet: '31566704',
  testnet: '10458941',
});

export const NETWORKS = Object.freeze({
  mainnet: { caip2: MAINNET_CAIP2, usdcAsaId: USDC_ASA.mainnet, isTestnet: false },
  testnet: { caip2: TESTNET_CAIP2, usdcAsaId: USDC_ASA.testnet, isTestnet: true },
});

export const DEFAULT_FACILITATOR = 'https://facilitator.goplausible.xyz';

export class ConfigError extends Error {
  constructor(problems) {
    super(`configuration rejected:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Build a frozen config from an environment-shaped object.
 *
 * @param {Record<string,string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const problems = [];

  const networkName = (env.ALGO_NETWORK ?? 'testnet').trim().toLowerCase();
  const network = NETWORKS[networkName];
  if (!network) {
    problems.push(
      `ALGO_NETWORK must be "mainnet" or "testnet", got "${env.ALGO_NETWORK}". Testnet is the default.`,
    );
  }

  // Mainnet needs a second, explicit acknowledgement. One typo in one variable
  // should not be enough to start charging real money.
  if (networkName === 'mainnet' && env.ALGO_ALLOW_MAINNET !== 'yes') {
    problems.push(
      'ALGO_NETWORK is mainnet but ALGO_ALLOW_MAINNET is not "yes". ' +
        'Set it deliberately; this service will not default into handling real funds.',
    );
  }

  const payTo = (env.ALGO_PAY_TO ?? '').trim();
  if (payTo === '') {
    problems.push('ALGO_PAY_TO is required: the Algorand address that receives payments.');
  } else {
    const check = validateAlgorandAddress(payTo);
    if (!check.valid) problems.push(`ALGO_PAY_TO is not a valid Algorand address: ${check.reason}`);
  }

  const facilitatorUrl = (env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(facilitatorUrl)) {
    problems.push(`X402_FACILITATOR_URL is not a URL: "${facilitatorUrl}"`);
  }
  if (networkName === 'mainnet' && facilitatorUrl.startsWith('http://')) {
    problems.push('a plaintext http facilitator URL is refused on mainnet');
  }

  const port = Number(env.PORT ?? 3010);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535, got "${env.PORT}"`);
  }

  const baseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
    problems.push(`PUBLIC_BASE_URL is not a URL: "${baseUrl}"`);
  }
  // The resource URL is what agents and the leaderboard see. localhost there is
  // a live endpoint nobody can reach.
  if (networkName === 'mainnet' && /localhost|127\.0\.0\.1/.test(baseUrl)) {
    problems.push(
      'PUBLIC_BASE_URL points at localhost while ALGO_NETWORK is mainnet; ' +
        'the resource URL is what agents and the facilitator record, so it has to be reachable.',
    );
  }

  const timeoutMs = Number(env.X402_FACILITATOR_TIMEOUT_MS ?? 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    problems.push(`X402_FACILITATOR_TIMEOUT_MS must be between 1000 and 120000, got "${env.X402_FACILITATOR_TIMEOUT_MS}"`);
  }

  const ledgerPath = (env.LEDGER_PATH ?? 'settlements.jsonl').trim();
  if (ledgerPath === '') problems.push('LEDGER_PATH cannot be empty');

  const tapePath = (env.TAPE_PATH ?? '').trim();

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    networkName,
    caip2: network.caip2,
    isTestnet: network.isTestnet,
    usdcAsaId: network.usdcAsaId,
    payTo,
    facilitatorUrl,
    facilitatorTimeoutMs: timeoutMs,
    port,
    baseUrl,
    ledgerPath,
    tapePath: tapePath === '' ? null : tapePath,
  });
}

/** A redacted view safe to print or log. There are no secrets here today, and this keeps it that way. */
export function describeConfig(cfg) {
  return {
    network: cfg.networkName,
    caip2: cfg.caip2,
    usdcAsaId: cfg.usdcAsaId,
    payTo: cfg.payTo,
    facilitator: cfg.facilitatorUrl,
    baseUrl: cfg.baseUrl,
    port: cfg.port,
    tape: cfg.tapePath ?? 'none configured',
  };
}
