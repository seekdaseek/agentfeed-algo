/**
 * The paying client.
 *
 * This exists so the service can be proven end to end by the person who owns
 * it, rather than waiting for a stranger to be the first ever payment. It is
 * also the only way to learn what the x402 settle hooks actually put in their
 * context object, which the ledger currently guesses at defensively.
 *
 * Two rules shape this file.
 *
 * The signing key never leaves the process. It is read from the environment,
 * converted to a signer, and never logged, never returned, never written to the
 * ledger. Only the derived public address is ever printed.
 *
 * And nothing is attempted before it can succeed. Paying requires the account
 * to exist, to be opted in to the asset, and to hold enough of it. All three are
 * checkable in one read, and all three produce a clear sentence when they fail
 * instead of a signing error thirty seconds later.
 */

import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { toClientAvmSigner } from '@x402/avm';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import algosdk from 'algosdk';

import { fromMicroUsdc } from './money.mjs';

/** Register under the namespace wildcard, which is what the AVM docs show. */
export const ALGORAND_WILDCARD = 'algorand:*';

export class PayerError extends Error {}

/**
 * Turn a 25 word mnemonic into a signer plus its public address.
 * The secret key is converted and handed straight to the library; it is never
 * returned to the caller, so there is nothing for a log line to catch.
 */
export function signerFromMnemonic(mnemonic) {
  const words = String(mnemonic ?? '').trim().split(/\s+/);
  if (words.length !== 25) {
    throw new PayerError(
      `an Algorand mnemonic is 25 words; got ${words.length}. Nothing was read from it.`,
    );
  }
  let account;
  try {
    account = algosdk.mnemonicToSecretKey(words.join(' '));
  } catch (err) {
    throw new PayerError(`that mnemonic did not decode: ${err?.message ?? String(err)}`);
  }
  return {
    address: account.addr.toString(),
    signer: toClientAvmSigner(Buffer.from(account.sk).toString('base64')),
  };
}

/** An algod client for the configured network, resolved by the library. */
export function algorandFor(cfg, { algorandClient = null } = {}) {
  if (algorandClient) return algorandClient;
  return cfg.isTestnet ? AlgorandClient.testNet() : AlgorandClient.mainNet();
}

/**
 * Can this account actually pay?
 *
 * Returns { ready, problems[], microUsdc, algoMicro }. Never throws on a
 * not-ready account, because "you have not opted in" is a diagnosis rather than
 * an exception.
 */
export async function payerReadiness(algorand, address, asaId, needMicro) {
  const problems = [];
  let info;
  try {
    info = await algorand.account.getInformation(address);
  } catch (err) {
    return {
      ready: false,
      problems: [
        `could not read the account: ${err?.message ?? String(err)}. ` +
          'An account that has never been funded does not exist on chain yet.',
      ],
      microUsdc: null,
      algoMicro: null,
    };
  }

  const algoMicro = BigInt(info?.balance?.microAlgo ?? info?.amount ?? 0);
  if (algoMicro === 0n) {
    problems.push('the account holds no ALGO, so it cannot hold an asset or sign anything');
  }

  const assets = info?.assets ?? [];
  const holding = assets.find((a) => String(a.assetId ?? a['asset-id']) === String(asaId));
  if (!holding) {
    problems.push(
      `the account is not opted in to asset ${asaId}; an Algorand account must opt in before it can ` +
        'hold or spend an ASA, and the opt in itself raises the minimum balance by 0.1 ALGO',
    );
    return { ready: false, problems, microUsdc: null, algoMicro };
  }

  const microUsdc = BigInt(holding.amount ?? 0);
  if (needMicro !== undefined && microUsdc < BigInt(needMicro)) {
    problems.push(
      `the account holds ${fromMicroUsdc(microUsdc)} USDC but the call costs ${fromMicroUsdc(needMicro)}`,
    );
  }

  return { ready: problems.length === 0, problems, microUsdc, algoMicro };
}

/** Build a payment enabled fetch for the configured network. */
export function payingFetch(signer, { algorandClient, fetchImpl = globalThis.fetch } = {}) {
  const client = new x402Client();
  client.register(ALGORAND_WILDCARD, new ExactAvmScheme(signer, { algorandClient }));
  return wrapFetchWithPayment(fetchImpl, client);
}

/**
 * Call a paid URL, paying if challenged.
 *
 * Returns everything worth recording: the status, the body, and whatever the
 * server put in the payment response header. That header is where the
 * settlement transaction id lives, and it is the first hard evidence that money
 * moved, so it is captured verbatim rather than summarised.
 */
export async function payAndFetch(url, signer, { algorandClient, fetchImpl } = {}) {
  const doFetch = payingFetch(signer, { algorandClient, fetchImpl });
  const res = await doFetch(url, { headers: { accept: 'application/json' } });

  // The v2 header is PAYMENT-RESPONSE. X-PAYMENT-RESPONSE is the v1 name and is
  // still emitted by some servers. Checking only the x- prefixed one reports a
  // completed settlement as unpaid, which is how this looked in production
  // before the ledger contradicted it.
  const header = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
  let settlement = null;
  if (header) {
    try {
      settlement = decodePaymentResponseHeader(header);
    } catch (err) {
      settlement = { undecodable: true, raw: header.slice(0, 200), error: err?.message ?? String(err) };
    }
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 500) };
  }

  return { status: res.status, settlement, body, paid: Boolean(header) };
}
