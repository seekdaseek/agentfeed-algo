/**
 * x402 wiring.
 *
 * Builds the resource server, derives the routes config from the catalog, and
 * attaches the ledger to the verify and settle hooks.
 *
 * One honest note about the hooks. The x402 core exposes onBeforeVerify,
 * onAfterVerify, onVerifyFailure, onBeforeSettle, onAfterSettle,
 * onSettleFailure and onVerifiedPaymentCanceled, and the exact shape of the
 * context each one receives is not something I have observed against a live
 * facilitator yet. Rather than assert a shape I have not seen, the extractor
 * below tries the plausible field paths, and when it cannot find a payer it
 * records the context's top level keys instead of writing a null and moving on.
 *
 * The first real settlement therefore teaches us the shape, and it does so in
 * the ledger where somebody will read it, instead of leaving a row of quiet
 * nulls that looks like data.
 */

import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { isAlgorandNetwork, normalizeAlgorandNetwork } from '@x402/avm';
import { declareDiscoveryExtension } from '@x402/extensions';
import { CHALLENGE_TAG } from './catalog.mjs';
import { EVENT } from './ledger.mjs';
import { priceFor } from './money.mjs';

export const SCHEME = 'exact';
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * Reconcile the facilitator's network identifiers with the library's.
 *
 * CAIP-2 caps a chain reference at 32 characters. @x402/avm follows that and
 * its exported constants, including the USDC_CONFIG asset table, are keyed by
 * the truncated form. The GoPlausible facilitator advertises Algorand with the
 * full 44 character base64 genesis hash, padding included, while advertising
 * Solana correctly truncated in the very same response.
 *
 * @x402/core then compares the two with a plain string equality inside its
 * capability check and concludes the facilitator does not support the network.
 * The result is that every paid route fails to build a payment challenge, which
 * surfaces as "Facilitator does not support scheme exact on network ...". This
 * is an upstream bug: the AVM mechanism package DOES know how to reconcile the
 * two forms, via normalizeAlgorandNetwork, and core simply never asks it to.
 *
 * Configuring the long form instead is not the fix. It would satisfy the string
 * comparison and then break asset resolution, because USDC_CONFIG has no key
 * for the untruncated identifier.
 *
 * So the reconciliation happens here, at the boundary, using the library's own
 * normaliser rather than a hand rolled one. verify and settle pass straight
 * through untouched. Observed against the live facilitator on 2026-08-05;
 * remove this once core normalises, and the tests will tell you when it does.
 */
export class NormalizingFacilitatorClient {
  constructor(inner) {
    this.inner = inner;
    this.normalizedCount = 0;
  }

  async getSupported() {
    const res = await this.inner.getSupported();
    const kinds = Array.isArray(res?.kinds) ? res.kinds : [];
    return {
      ...res,
      kinds: kinds.map((k) => {
        const network = normalizeNetwork(k?.network);
        if (network !== k?.network) this.normalizedCount += 1;
        return { ...k, network };
      }),
    };
  }

  verify(...args) {
    return this.inner.verify(...args);
  }

  settle(...args) {
    return this.inner.settle(...args);
  }
}

/** Defer to the AVM package for Algorand; leave every other namespace alone. */
export function normalizeNetwork(network) {
  if (typeof network !== 'string') return network;
  try {
    if (isAlgorandNetwork(network)) return normalizeAlgorandNetwork(network);
  } catch {
    // An identifier the AVM package cannot parse is not ours to rewrite.
  }
  return network;
}

/**
 * Derive the x402 RoutesConfig from the compiled catalog.
 * Nothing about pricing or description is written twice.
 */
export function buildRoutes(compiled, cfg) {
  const routes = {};
  for (const entry of compiled) {
    routes[entry.path] = {
      accepts: [
        {
          scheme: SCHEME,
          network: cfg.caip2,
          payTo: cfg.payTo,
          price: priceFor(entry.micro, cfg.usdcAsaId),
          maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
          // Global x402 Challenge attribution. The leaderboard filters on
          // accepts[].extra.tag, NOT resource.tags. Confirmed by the Algorand
          // Foundation 2026-08-11; settlements before this were not counted.
          // resource.tags stays as it is, for Bazaar discovery.
          extra: { tag: CHALLENGE_TAG },
        },
      ],
      resource: `${cfg.baseUrl}${entry.path}`,
      description: entry.description,
      mimeType: 'application/json',
      serviceName: 'AgentFeed',
      tags: [...entry.tags],
      // Bazaar discovery. The Global x402 Challenge requires entered endpoints
      // to be discoverable, and discovery is what makes an endpoint findable by
      // an agent that has never heard of it. Each route declares its HTTP
      // method and the query parameters it takes, so a caller can construct a
      // valid request from the listing alone rather than reading these docs.
      extensions: declareDiscoveryExtension({
        method: 'GET',
        input: entry.input ?? {},
      }),
      // What a caller sees before paying. Enough to decide, not enough to skip
      // paying, and it names the status vocabulary so the paid response is
      // legible the first time.
      unpaidResponseBody: () => ({
        contentType: 'application/json',
        body: {
          route: entry.id,
          price_usdc: entry.price,
          network: cfg.caip2,
          asset: cfg.usdcAsaId,
          unlocks: entry.description,
          query: entry.query ?? null,
          response_status_vocabulary: ['measured', 'absent', 'unmeasured'],
          note: 'unmeasured responses are never billed',
        },
      }),
    };
  }
  return routes;
}

/**
 * Pull what we can out of a hook context without pretending to know its shape.
 * Returns the fields found plus, when the payer is missing, the keys that were
 * actually present so the gap is diagnosable from the ledger alone.
 */
export function extractSettlement(ctx) {
  const c = ctx ?? {};
  // Shape observed live on 2026-08-05 against the GoPlausible facilitator:
  // { paymentPayload, requirements, declaredExtensions, transportContext, result }
  const payload = c.paymentPayload ?? c.payload ?? c.payment ?? {};
  const requirements = c.requirements ?? c.paymentRequirements ?? {};
  const response = c.result ?? c.settleResponse ?? c.response ?? {};

  const payer =
    response.payer ?? c.payer ?? payload.payer ?? payload.from ?? payload.sender ?? null;

  const txId =
    response.transaction ?? response.txId ?? response.txID ?? response.transactionId ?? c.txId ?? null;

  const amount = requirements.maxAmountRequired ?? requirements.amount ?? c.amount ?? null;
  const asset = requirements.asset ?? c.asset ?? null;
  const network = requirements.network ?? payload.network ?? c.network ?? null;

  const found = { payer, txId, amountMicro: amount, asset, network };
  if (payer === null || txId === null) {
    found.shape = Object.keys(c).slice(0, 20);
  }
  return found;
}

/** Map an express path back to the catalog id, so the ledger is queryable by product. */
export function routeIdForPath(compiled, path) {
  if (typeof path !== 'string') return null;
  const clean = path.split('?')[0];
  return compiled.find((e) => e.path === clean)?.id ?? null;
}

/**
 * Build the resource server and attach the ledger.
 * facilitatorClient is injectable so tests never touch the network.
 */
export function buildResourceServer(cfg, compiled, ledger, { facilitatorClient = null, schemeServer = null } = {}) {
  // No normalisation. The config now uses the identifiers the facilitator
  // itself accepts, so core's capability check and the facilitator's verify
  // agree without anything in between rewriting them.
  const facilitator =
    facilitatorClient ??
    new HTTPFacilitatorClient({ url: cfg.facilitatorUrl, timeoutMs: cfg.facilitatorTimeoutMs });

  const server = new x402ResourceServer(facilitator);
  server.register(cfg.caip2, schemeServer ?? new ExactAvmScheme());

  const note = (event, ctx, reason = null) => {
    const f = extractSettlement(ctx);
    // requirements.resource carries the full URL we published for the route, so
    // the ledger can name what was bought without guessing at transportContext.
    const path =
      ctx?.requirements?.resource ??
      ctx?.paymentRequirements?.resource ??
      ctx?.path ??
      ctx?.resource ??
      ctx?.transportContext?.path ??
      null;
    return ledger.record({
      event,
      routeId: routeIdForPath(compiled, stripBase(path, cfg.baseUrl)),
      path: stripBase(path, cfg.baseUrl),
      payer: f.payer,
      amountMicro: f.amountMicro,
      asset: f.asset,
      network: f.network ?? cfg.caip2,
      txId: f.txId,
      reason: reason ?? (f.shape ? `context keys seen: ${f.shape.join(',')}` : null),
    });
  };

  // Hook registration is wrapped because a ledger problem must never break a
  // paid request. If a hook name ever changes upstream this degrades to no
  // ledger rather than to a crash on the first payment.
  safely(() =>
    server.onAfterVerify?.((ctx) =>
      verifyPassed(ctx)
        ? note(EVENT.VERIFIED, ctx)
        : note(EVENT.VERIFY_FAILED, ctx, reasonOf(ctx)),
    ),
  );
  safely(() => server.onVerifyFailure?.((ctx) => note(EVENT.VERIFY_FAILED, ctx, reasonOf(ctx))));
  safely(() =>
    server.onAfterSettle?.((ctx) =>
      settlePassed(ctx) ? note(EVENT.SETTLED, ctx) : note(EVENT.SETTLE_FAILED, ctx, reasonOf(ctx)),
    ),
  );
  safely(() => server.onSettleFailure?.((ctx) => note(EVENT.SETTLE_FAILED, ctx, reasonOf(ctx))));
  safely(() => server.onVerifiedPaymentCanceled?.((ctx) => note(EVENT.CANCELED, ctx, reasonOf(ctx))));

  return server;
}

function reasonOf(ctx) {
  const r = ctx?.result ?? {};
  return (
    r.invalidReason ??
    r.errorReason ??
    ctx?.error?.message ??
    ctx?.reason ??
    ctx?.errorReason ??
    (Object.keys(r).length ? JSON.stringify(r).slice(0, 400) : null)
  );
}

/**
 * Did the verify actually pass?
 *
 * onAfterVerify fires after the call regardless of the verdict, and the verdict
 * lives in ctx.result.isValid. Recording every invocation as "verified" was a
 * bug of exactly the kind this service exists to prevent: an outcome written
 * down without checking its status. Caught on the first real mainnet payment,
 * where a rejected payment appeared in the ledger as verified.
 */
function verifyPassed(ctx) {
  return ctx?.result?.isValid === true;
}

function settlePassed(ctx) {
  const r = ctx?.result ?? {};
  return r.success === true || (r.success === undefined && Boolean(r.transaction ?? r.txId));
}

function stripBase(path, baseUrl) {
  if (typeof path !== 'string') return null;
  return path.startsWith(baseUrl) ? path.slice(baseUrl.length) || '/' : path;
}

function safely(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}
