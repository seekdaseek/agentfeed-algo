#!/usr/bin/env node
/**
 * agentfeed-algo
 *
 *   doctor     run every preflight check and say whether this is safe to start
 *   catalog    print what is sold and for how much
 *   ledger     usage summary, concentration first
 *   serve      start the service, refusing mainnet unless the preflight passes
 */

import { readFile, appendFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { loadConfig, describeConfig, ConfigError } from '../src/config.mjs';
import { preflight, renderPreflight } from '../src/preflight.mjs';
import { compileCatalog, sweepPrice } from '../src/catalog.mjs';
import { fromMicroUsdc } from '../src/money.mjs';
import { Ledger } from '../src/ledger.mjs';
import { startServer } from '../src/server.mjs';
import { SqliteTapeStore, MissingTapeStore } from '../src/tape.mjs';
import { signerFromMnemonic, algorandFor, payerReadiness, payAndFetch, PayerError } from '../src/payer.mjs';
import { compileCatalog as compileCatalogForPay } from '../src/catalog.mjs';

const USAGE = `agentfeed-algo - a paid x402 data API on Algorand

  agentfeed-algo doctor     check config, catalog and facilitator
  agentfeed-algo catalog    list the paid routes and prices
  agentfeed-algo ledger     usage summary from the settlement ledger
  agentfeed-algo serve      start the service
  agentfeed-algo newpayer   generate a throwaway TESTNET paying account into .env
  agentfeed-algo payer      show the paying account and whether it can pay
  agentfeed-algo pay <url>  call a paid route, paying if challenged

Options
  --json       machine readable output
  --env-file   path to a dotenv style file, default .env

Environment
  ALGO_NETWORK           mainnet or testnet, default testnet
  ALGO_ALLOW_MAINNET     must be yes to run on mainnet
  ALGO_PAY_TO            Algorand address that receives payments
  X402_FACILITATOR_URL   default https://facilitator.goplausible.xyz
  PUBLIC_BASE_URL        the URL agents and the facilitator will record
  TAPE_PATH              sqlite liquidation tape, read only
  LEDGER_PATH            settlement ledger, default settlements.jsonl
  PORT                   default 3010
  ALGO_PAYER_MNEMONIC    25 word mnemonic for the paying account, client side only.
                         Never printed, never logged, never written to the ledger.
`;

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/** Load a dotenv style file without a dependency. Real env wins. */
async function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = await readFile(path, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const name = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
  }
}

function config() {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
}

async function cmdDoctor(opts) {
  const cfg = config();
  const result = await preflight(cfg);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ config: describeConfig(cfg), ...result, compiled: undefined }, null, 2)}\n`);
  } else {
    const d = describeConfig(cfg);
    process.stdout.write(
      `network   ${d.network}\npayTo     ${d.payTo}\nasset     USDC ASA ${d.usdcAsaId}\nbase      ${d.baseUrl}\ntape      ${d.tape}\n\n${renderPreflight(result)}\n`,
    );
  }
  process.exit(result.ok ? 0 : 2);
}

function cmdCatalog(opts) {
  const compiled = compileCatalog();
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(compiled.map((e) => ({ ...e, micro: e.micro.toString() })), null, 2)}\n`,
    );
    return;
  }
  for (const e of compiled) {
    process.stdout.write(`  ${e.price.padStart(6)} USDC  ${e.path}\n                 ${e.description}\n`);
  }
  process.stdout.write(`\n  every route once costs ${fromMicroUsdc(sweepPrice(compiled))} USDC\n`);
}

async function cmdLedger(opts) {
  const cfg = config();
  const summary = await new Ledger(cfg.ledgerPath).summary();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `events        ${summary.events}\nsettlements   ${summary.settlements}\n` +
      `verify fails  ${summary.verifyFailures}\nsettle fails  ${summary.settleFailures}\n` +
      `payers        ${summary.distinctPayers}\ntotal         ${fromMicroUsdc(summary.totalMicro)} USDC\n\n` +
      `  ${summary.concentrationNote}\n`,
  );
}

async function cmdServe(opts) {
  const cfg = config();
  const result = await preflight(cfg);

  // Testnet may start with warnings. Mainnet may not start at all unless every
  // check passes, because on mainnet a misconfiguration takes real money to the
  // wrong place and there is no undo.
  if (!result.ok) {
    process.stderr.write(`${renderPreflight(result)}\n`);
    fail(`refusing to start on ${cfg.networkName} with ${result.fatal} fatal problem(s)`, 2);
  }
  if (!cfg.isTestnet && result.warnings > 0) {
    process.stderr.write(`${renderPreflight(result)}\n`);
    fail(`refusing to start on mainnet with ${result.warnings} warning(s); resolve them or run on testnet`, 2);
  }

  let store = new MissingTapeStore();
  if (cfg.tapePath) {
    const { DatabaseSync } = await import('node:sqlite');
    store = new SqliteTapeStore(cfg.tapePath, { DatabaseSync });
  }

  const { port } = await startServer(cfg, { store, ledger: new Ledger(cfg.ledgerPath) });
  process.stdout.write(
    `agentfeed-algo listening on ${port}\n  network   ${cfg.caip2}\n  payTo     ${cfg.payTo}\n  catalog   ${cfg.baseUrl}/catalog\n  manifest  ${cfg.baseUrl}/.well-known/x402\n`,
  );
}

/**
 * Load the paying account.
 *
 * The mnemonic is read, converted, and dropped. Only the public address comes
 * back out, so nothing downstream can print what it must not print.
 */
function loadPayer() {
  const mnemonic = process.env.ALGO_PAYER_MNEMONIC;
  if (!mnemonic) {
    fail(
      'ALGO_PAYER_MNEMONIC is not set.\n\n' +
        'This is the account that PAYS, which is not the same as ALGO_PAY_TO, the account that receives.\n' +
        'Put it in .env yourself so it never passes through a shell history:\n' +
        '  printf "Paste the 25 word mnemonic: "; read -rs M; echo; printf "ALGO_PAYER_MNEMONIC=%s\\n" "$M" >> .env; unset M\n' +
        'Then: chmod 600 .env',
    );
  }
  try {
    return signerFromMnemonic(mnemonic);
  } catch (err) {
    if (err instanceof PayerError) fail(err.message);
    throw err;
  }
}

/**
 * Generate a throwaway paying account, testnet only.
 *
 * This exists so a mnemonic never has to be typed, pasted through a terminal,
 * or copied out of a wallet app to run a test payment. The key is generated
 * here, written straight into .env at mode 600, and only the public address is
 * ever printed.
 *
 * It refuses on mainnet, deliberately. A key that spends real money should come
 * from a wallet the operator controls and has backed up, not from a command
 * that scribbled it into a dotfile.
 */
async function cmdNewPayer(opts) {
  const cfg = config();
  if (!cfg.isTestnet) {
    fail(
      'newpayer refuses to run on mainnet.\n' +
        'Generate mainnet keys in a wallet you control and have backed up, then set ALGO_PAYER_MNEMONIC yourself.',
    );
  }

  const envPath = opts['env-file'] ?? '.env';
  if (process.env.ALGO_PAYER_MNEMONIC) {
    fail(
      `ALGO_PAYER_MNEMONIC is already set, so nothing was generated and nothing was overwritten.\n` +
        `Remove it from ${envPath} first if you really want a new account.`,
    );
  }

  const algosdk = (await import('algosdk')).default;
  const account = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
  const address = account.addr.toString();

  await appendFile(envPath, `\nALGO_PAYER_MNEMONIC=${mnemonic}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);

  process.stdout.write(
    [
      '',
      `A throwaway TESTNET paying account was generated and written to ${envPath} (chmod 600).`,
      `  address  ${address}`,
      '',
      'The mnemonic is in that file and was not printed. It holds nothing until you fund it.',
      '',
      'Next, in order:',
      `  1. Fund it with testnet ALGO:  https://lora.algokit.io/testnet/fund`,
      `  2. Opt it in to USDC ASA ${cfg.usdcAsaId} and get testnet USDC from the Algorand dispenser`,
      '  3. node bin/agentfeed-algo.mjs payer',
      '',
    ].join('\n'),
  );
}

async function cmdPayer(opts) {
  const cfg = config();
  const { address } = loadPayer();
  const algorand = algorandFor(cfg);
  const cheapest = compileCatalogForPay().reduce((a, e) => (e.micro < a ? e.micro : a), 10n ** 30n);
  const r = await payerReadiness(algorand, address, cfg.usdcAsaId, cheapest);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ address, network: cfg.networkName, asaId: cfg.usdcAsaId, ...r, microUsdc: r.microUsdc?.toString() ?? null, algoMicro: r.algoMicro?.toString() ?? null }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `payer     ${address}\n` +
        `network   ${cfg.networkName}\n` +
        `asset     USDC ASA ${cfg.usdcAsaId}\n` +
        `algo      ${r.algoMicro === null ? 'unknown' : `${Number(r.algoMicro) / 1e6} ALGO`}\n` +
        `usdc      ${r.microUsdc === null ? 'not opted in' : `${fromMicroUsdc(r.microUsdc)} USDC`}\n\n` +
        (r.ready ? '  ready to pay\n' : r.problems.map((x) => `  BLOCKED  ${x}\n`).join('')),
    );
  }
  process.exit(r.ready ? 0 : 2);
}

async function cmdPay(url, opts) {
  if (!url) fail('usage: agentfeed-algo pay <url>');
  const cfg = config();
  const { address, signer } = loadPayer();
  const algorandClient = algorandFor(cfg);

  process.stdout.write(`paying from ${address} on ${cfg.networkName}\n`);

  let result;
  try {
    result = await payAndFetch(url, signer, { algorandClient });
  } catch (err) {
    fail(`payment failed: ${err?.message ?? err}`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`status    ${result.status}\n`);
    process.stdout.write(`paid      ${result.paid ? 'yes' : 'no payment header returned'}\n`);
    if (result.settlement) {
      process.stdout.write(`settlement ${JSON.stringify(result.settlement)}\n`);
    }
    const b = result.body ?? {};
    if (b.status) process.stdout.write(`envelope  ${b.status}\n`);
    process.stdout.write(`body      ${JSON.stringify(b).slice(0, 600)}\n`);
  }
  process.exit(result.status === 200 ? 0 : 3);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      'env-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return;
  }

  await loadEnvFile(values['env-file'] ?? '.env');

  switch (positionals[0]) {
    case 'doctor':
      return cmdDoctor(values);
    case 'catalog':
      return cmdCatalog(values);
    case 'ledger':
      return cmdLedger(values);
    case 'serve':
      return cmdServe(values);
    case 'newpayer':
      return cmdNewPayer(values);
    case 'payer':
      return cmdPayer(values);
    case 'pay':
      return cmdPay(positionals[1], values);
    default:
      fail(`unknown command "${positionals[0]}"\n\n${USAGE}`);
  }
}

main().catch((err) => fail(`agentfeed-algo: ${err?.message ?? err}`));
