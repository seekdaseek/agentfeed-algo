/**
 * The service.
 *
 * Free surfaces come first and are deliberately generous: /catalog and
 * /.well-known/x402 tell an agent exactly what exists, what it costs and what
 * the response will look like, before any money moves. A paid API that cannot
 * be understood without paying will not be discovered by anything autonomous.
 *
 * Then the paywall, then the data.
 *
 * The ordering inside a paid handler is the part worth reading. We compute the
 * answer, and if it came back unmeasured we return 503 instead of 200. The
 * payment has already been verified at that point, so this costs us the sale.
 * That is the intended trade. Charging for a hole is how a per call feed loses
 * the only thing it has, which is that its numbers can be trusted.
 */

import express from 'express';
import { paymentMiddleware } from '@x402/express';

import { compileCatalog, sweepPrice, CATALOG } from './catalog.mjs';
import { landingHtml, tapeSnapshot, ICON_PNG } from './landing.mjs';
import { buildRoutes, buildResourceServer } from './x402.mjs';
import { fromMicroUsdc } from './money.mjs';
import { HANDLERS, MissingTapeStore } from './tape.mjs';
import { isBillable, forWire } from './envelope.mjs';
import { Ledger } from './ledger.mjs';

export function createApp(cfg, {
  store = new MissingTapeStore(),
  ledger = new Ledger(cfg.ledgerPath),
  catalog = CATALOG,
  facilitatorClient = null,
  schemeServer = null,
  now = Date.now,
  withPaywall = true,
  syncFacilitatorOnStart = true,
} = {}) {
  const compiled = compileCatalog(catalog);
  const app = express();
  app.disable('x-powered-by');

  // ---- free surfaces ----

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'agentfeed-algo',
      network: cfg.caip2,
      routes: compiled.length,
      tape: cfg.tapePath ? 'configured' : 'absent',
    });
  });

  // The root earns its own page, which the comment here used to anticipate.
  // It answers HTML rather than redirecting to /catalog because every directory
  // that lists this service builds its entry from a page title and an icon, and
  // application/json carries neither: on the GoPlausible leaderboard this
  // merchant rendered as a truncated wallet address for a month. The page is
  // generated from the compiled catalog, so it cannot drift from what is sold.
  app.get('/', (_req, res) => {
    res
      .type('html')
      .set('Cache-Control', 'public, max-age=300')
      .send(
        landingHtml(cfg, compiled, {
          sweep: fromMicroUsdc(sweepPrice(compiled)),
          tape: tapeSnapshot(store, { now }),
        }),
      );
  });

  // Both names are served because crawlers disagree about which to ask for.
  for (const iconPath of ['/favicon.ico', '/apple-touch-icon.png']) {
    app.get(iconPath, (_req, res) => {
      res
        .type('image/png')
        .set('Cache-Control', 'public, max-age=86400')
        .send(ICON_PNG);
    });
  }

  app.get('/catalog', (_req, res) => {
    res.json({
      service: 'AgentFeed on Algorand',
      network: cfg.caip2,
      asset: { asaId: cfg.usdcAsaId, symbol: 'USDC', decimals: 6 },
      payTo: cfg.payTo,
      sweep_price_usdc: fromMicroUsdc(sweepPrice(compiled)),
      status_vocabulary: {
        measured: 'we asked and got an answer',
        absent: 'we asked and the market had none, which is a finding',
        unmeasured: 'our own lookup failed, which is not a finding and is never billed',
      },
      routes: compiled.map((e) => ({
        id: e.id,
        path: e.path,
        price_usdc: e.price,
        unlocks: e.description,
        query: e.query ?? null,
        tags: e.tags,
      })),
    });
  });

  app.get('/.well-known/x402', (_req, res) => {
    res.json({
      x402Version: 2,
      network: cfg.caip2,
      payTo: cfg.payTo,
      asset: cfg.usdcAsaId,
      facilitator: cfg.facilitatorUrl,
      resources: compiled.map((e) => ({
        resource: `${cfg.baseUrl}${e.path}`,
        scheme: 'exact',
        price: { asset: cfg.usdcAsaId, amount: e.micro.toString() },
        description: e.description,
        tags: [...e.tags],
        input: e.input ?? {},
      })),
    });
  });

  // ---- paywall ----

  if (withPaywall) {
    const routes = buildRoutes(compiled, cfg);
    const server = buildResourceServer(cfg, compiled, ledger, { facilitatorClient, schemeServer });
    const pay = paymentMiddleware(routes, server, undefined, undefined, syncFacilitatorOnStart);

    // A facilitator outage must not read as a server bug.
    //
    // Without the facilitator's supported kinds the middleware cannot build a
    // payment challenge at all, and the raw failure surfaces as a 500. To an
    // agent that is indistinguishable from "this API is broken, stop trying",
    // when the truth is "the payment rail is down, come back shortly". So the
    // outage is translated into 503 with a Retry-After and a body that names
    // which facilitator failed.
    //
    // Free routes are registered above this point and are unaffected, so the
    // catalog and the manifest stay readable during an outage. An agent can
    // still discover what this service sells while it cannot yet buy it.
    app.use(async (req, res, next) => {
      try {
        await pay(req, res, next);
      } catch (err) {
        respondPaymentUnavailable(res, cfg, err);
      }
    });

    app.use((err, _req, res, next) => {
      if (res.headersSent) return next(err);
      respondPaymentUnavailable(res, cfg, err);
    });
  }

  // ---- paid data ----

  for (const entry of compiled) {
    const handler = HANDLERS[entry.id];
    if (!handler) {
      throw new Error(`catalog entry "${entry.id}" has no handler; the catalog and code disagree`);
    }
    app.get(entry.path, (req, res) => {
      let env;
      try {
        env = handler(store, {
          symbol: req.query.symbol,
          hours: req.query.hours ?? undefined,
          minutes: req.query.minutes ?? undefined,
          now: now(),
        });
      } catch (err) {
        // A thrown handler is our failure. Say so, do not invent a body.
        res.status(503).json(
          forWire(
            {
              status: 'unmeasured',
              value: null,
              asOf: null,
              basis: 'handler threw',
              source: 'agentfeed',
              failure: { reason: err?.message ?? String(err) },
            },
            { route: entry.id, network: cfg.caip2 },
          ),
        );
        return;
      }

      const body = forWire(env, { route: entry.id, network: cfg.caip2 });
      if (!isBillable(env)) {
        // Payment was already verified upstream. We give the answer away rather
        // than bill for a lookup that failed on our side.
        res.status(503).json({ ...body, billing: 'not billable; this response cost you nothing' });
        return;
      }
      res.json(body);
    });
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  return app;
}


/**
 * The one response shape for "we cannot take payment right now".
 *
 * 503 rather than 500, because the request was fine and the service is not
 * broken. Retry-After so an autonomous caller has a number to back off on
 * instead of guessing or hammering.
 */
function respondPaymentUnavailable(res, cfg, err) {
  res.status(503).set('Retry-After', '30').json({
    error: 'payment_unavailable',
    detail:
      'the x402 facilitator could not be reached, so no payment challenge could be issued; ' +
      'this is our payment rail, not your request',
    facilitator: cfg.facilitatorUrl,
    network: cfg.caip2,
    retry_after_seconds: 30,
    free_surfaces: ['/', '/health', '/catalog', '/.well-known/x402'],
    cause: err?.message ?? String(err),
  });
}

export function startServer(cfg, opts = {}) {
  const app = createApp(cfg, opts);
  return new Promise((resolve) => {
    const srv = app.listen(cfg.port, () => resolve({ app, server: srv, port: srv.address().port }));
  });
}
