/**
 * Opt the paying account in to the configured USDC asset.
 *
 * An Algorand account cannot receive or hold an ASA until it has opted in, and
 * the opt in itself costs a fee and raises the account's minimum balance by
 * 0.1 ALGO. So the order is fixed: fund with ALGO, opt in, then the USDC can
 * arrive. Sending USDC to an account that has not opted in fails with "asset
 * missing in destination account".
 *
 * Works on whichever network the config selects. It reads the account first and
 * exits quietly if the opt in already happened, so it is safe to re-run.
 */
import { readFile } from 'node:fs/promises';
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { loadConfig } from '../src/config.mjs';

for (const line of (await readFile('.env', 'utf8')).split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.trim().startsWith('#')) {
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
  }
}

const cfg = loadConfig();
if (!process.env.ALGO_PAYER_MNEMONIC) {
  console.error('ALGO_PAYER_MNEMONIC is not set; nothing to opt in');
  process.exit(1);
}

const algorand = cfg.isTestnet ? AlgorandClient.testNet() : AlgorandClient.mainNet();
const account = algorand.account.fromMnemonic(process.env.ALGO_PAYER_MNEMONIC);
const assetId = BigInt(cfg.usdcAsaId);
const addr = account.addr.toString();

const info = await algorand.account.getInformation(addr);
console.log('network', cfg.networkName, '| asset', String(assetId));
console.log('account', addr);
console.log('algo   ', Number(info.balance?.microAlgo ?? 0) / 1e6);

if ((info.assets ?? []).some((a) => String(a.assetId ?? a['asset-id']) === String(assetId))) {
  console.log('already opted in');
  process.exit(0);
}
if (!cfg.isTestnet) console.log('mainnet: this spends real ALGO and locks 0.1 as minimum balance');

const res = await algorand.send.assetOptIn({ sender: account.addr, assetId });
console.log('opted in, txid', res.txIds?.[0] ?? JSON.stringify(res).slice(0, 200));
