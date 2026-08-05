/**
 * Call a paid route, paying if challenged.
 *
 * With no URL it reports readiness and stops, which is the safe default: it
 * names what is missing rather than failing mid signature. With a URL it pays
 * and prints whatever the server returned in the payment response header, since
 * that is where the settlement transaction id lives.
 */
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { signerFromMnemonic, algorandFor, payerReadiness, payAndFetch } from '../src/payer.mjs';
import { compileCatalog } from '../src/catalog.mjs';
import { fromMicroUsdc } from '../src/money.mjs';

for (const line of (await readFile('.env', 'utf8')).split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.trim().startsWith('#')) {
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
  }
}

const cfg = loadConfig();
if (!process.env.ALGO_PAYER_MNEMONIC) {
  console.error('ALGO_PAYER_MNEMONIC is not set');
  process.exit(1);
}

const cheapest = compileCatalog().reduce((a, e) => (e.micro < a ? e.micro : a), 10n ** 30n);
const { address, signer } = signerFromMnemonic(process.env.ALGO_PAYER_MNEMONIC);
const algorand = algorandFor(cfg);
const r = await payerReadiness(algorand, address, cfg.usdcAsaId, cheapest);

console.log('network', cfg.networkName, '| asset', cfg.usdcAsaId);
console.log('payer  ', address);
console.log('algo   ', r.algoMicro === null ? 'unknown' : Number(r.algoMicro) / 1e6);
console.log('usdc   ', r.microUsdc === null ? 'NOT OPTED IN' : fromMicroUsdc(r.microUsdc));
if (!r.ready) {
  for (const p of r.problems) console.log('BLOCKED', p);
  process.exit(2);
}

const url = process.argv[2];
if (!url) {
  console.log('ready to pay. pass a URL as an argument.');
  process.exit(0);
}

const out = await payAndFetch(url, signer, { algorandClient: algorand });
console.log('status ', out.status);
console.log('paid   ', out.paid);
console.log('settle ', JSON.stringify(out.settlement));
console.log('body   ', JSON.stringify(out.body).slice(0, 800));
process.exit(out.status === 200 ? 0 : 3);
