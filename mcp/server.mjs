#!/usr/bin/env node
/**
 * AgentFeed on Algorand, as an MCP server.
 *
 * This exists because agents do not browse. Their operators install packages,
 * and whatever tools come with that package are what the agent can reach. A
 * paid API that is only a URL is invisible to the thing meant to pay for it.
 *
 * Every tool here calls the live endpoint over x402 and pays from the operator's
 * own Algorand account. There is no key of ours in the loop and no account to
 * create: the operator sets one environment variable and their agent can buy
 * liquidation data by the call.
 *
 * Two deliberate choices.
 *
 * The catalog and payer_status tools are free and need no key, so an operator
 * can install this, see exactly what exists and what it costs, and decide
 * afterwards whether to fund anything. A server that demands a private key
 * before it will tell you what it sells does not get installed twice.
 *
 * And an unmeasured response is surfaced as an error rather than as data. The
 * HTTP layer already refuses to bill it, but an agent reading a tool result
 * needs the same signal, and the one thing worse than no answer is a hole that
 * looks like an answer.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { compileCatalog, CATALOG } from '../src/catalog.mjs';
import { fromMicroUsdc } from '../src/money.mjs';
import { signerFromMnemonic, algorandFor, payerReadiness, payAndFetch } from '../src/payer.mjs';
import { NETWORKS } from '../src/config.mjs';

const BASE_URL = (process.env.AGENTFEED_ALGO_URL ?? 'https://algo.ochinimus.app').replace(/\/+$/, '');
const NETWORK_NAME = (process.env.ALGO_NETWORK ?? 'mainnet').toLowerCase();
const NETWORK = NETWORKS[NETWORK_NAME] ?? NETWORKS.mainnet;

const compiled = compileCatalog(CATALOG);

/** Resolve the paying account once, lazily, so the free tools work without a key. */
let payerCache = null;
function payer() {
  if (payerCache) return payerCache;
  const mnemonic = process.env.ALGO_PAYER_MNEMONIC;
  if (!mnemonic) {
    throw new Error(
      'ALGO_PAYER_MNEMONIC is not set. This server pays from your own Algorand account: ' +
        'set that variable to a 25 word mnemonic for an account holding USDC and opted in to ' +
        `asset ${NETWORK.usdcAsaId}. Use the catalog tool to see prices before funding anything.`,
    );
  }
  const { address, signer } = signerFromMnemonic(mnemonic);
  payerCache = { address, signer, algorand: algorandFor({ isTestnet: NETWORK.isTestnet }) };
  return payerCache;
}

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }],
});
const failure = (message) => ({ ...text(message), isError: true });

/**
 * Call a paid route and translate the envelope into an MCP result.
 * measured and absent are answers. unmeasured is not, and is returned as an error.
 */
async function callPaid(entry, params) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  const url = `${BASE_URL}${entry.path}${query ? `?${query}` : ''}`;

  let p;
  try {
    p = payer();
  } catch (err) {
    return failure(err.message);
  }

  let out;
  try {
    out = await payAndFetch(url, p.signer, { algorandClient: p.algorand });
  } catch (err) {
    return failure(`payment or request failed: ${err?.message ?? String(err)}`);
  }

  const body = out.body ?? {};
  if (body.status === 'unmeasured') {
    return failure(
      `unmeasured: ${body.basis ?? 'the lookup failed on our side'}. ` +
        'This is not a finding about the market and you were not billed for it.',
    );
  }
  if (out.status !== 200) {
    return failure(`HTTP ${out.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }

  return text({
    ...body,
    paid: out.paid ? fromMicroUsdc(entry.micro) + ' USDC' : 'no payment header returned',
    settlement: out.settlement ?? null,
  });
}

const server = new McpServer({ name: 'agentfeed-algo', version: '0.1.0' });

// ---- free tools ----

server.registerTool(
  'catalog',
  {
    title: 'List what this feed sells and what it costs',
    description:
      'Free. Returns every paid route, its price in USDC, what the payment unlocks, and the ' +
      'parameters it takes. Call this first; no Algorand account is needed.',
    inputSchema: {},
  },
  async () =>
    text({
      service: 'AgentFeed on Algorand',
      base_url: BASE_URL,
      network: NETWORK.caip2,
      asset: { asaId: NETWORK.usdcAsaId, symbol: 'USDC', decimals: 6 },
      routes: compiled.map((e) => ({
        tool: e.id,
        price_usdc: e.price,
        unlocks: e.description,
        parameters: e.query ?? 'none',
      })),
      every_route_once_costs: `${fromMicroUsdc(compiled.reduce((a, e) => a + e.micro, 0n))} USDC`,
      response_status_vocabulary: {
        measured: 'we asked and got an answer',
        absent: 'we asked and the market had none, which is a real finding',
        unmeasured: 'our own lookup failed; never billed, returned as a tool error',
      },
    }),
);

server.registerTool(
  'payer_status',
  {
    title: 'Check whether your account can pay',
    description:
      'Free. Reports the paying address, its ALGO and USDC balances, and anything blocking ' +
      'payment such as a missing asset opt-in. Run this before the paid tools.',
    inputSchema: {},
  },
  async () => {
    let p;
    try {
      p = payer();
    } catch (err) {
      return failure(err.message);
    }
    const cheapest = compiled.reduce((a, e) => (e.micro < a ? e.micro : a), 10n ** 30n);
    const r = await payerReadiness(p.algorand, p.address, NETWORK.usdcAsaId, cheapest);
    return text({
      payer: p.address,
      network: NETWORK_NAME,
      asset: NETWORK.usdcAsaId,
      algo: r.algoMicro === null ? 'unknown' : Number(r.algoMicro) / 1e6,
      usdc: r.microUsdc === null ? 'not opted in to the asset' : fromMicroUsdc(r.microUsdc),
      ready: r.ready,
      blocked_by: r.problems,
    });
  },
);

// ---- paid tools ----

const SYMBOL = z
  .string()
  .describe('Ticker or exchange pair. SOL and SOLUSDT both work; bare tickers are resolved.');

server.registerTool(
  'liquidation_window',
  {
    title: 'Forced liquidation volume for one symbol',
    description:
      'Paid, 0.02 USDC. Total liquidation volume over a recent window, split by exchange and by ' +
      'whether longs or shorts were liquidated. Exchange totals are not directly comparable; the ' +
      'response says which venues undercount and why.',
    inputSchema: {
      symbol: SYMBOL,
      hours: z.number().int().min(1).max(168).default(24).describe('Window length in hours, 1 to 168.'),
    },
  },
  async ({ symbol, hours }) =>
    callPaid(compiled.find((e) => e.id === 'liquidation_window'), { symbol, hours }),
);

server.registerTool(
  'liquidation_cascade',
  {
    title: 'Whether liquidations arrived as a burst or spread out',
    description:
      'Paid, 0.05 USDC. Concentration score for one symbol: the share of the window\'s liquidation ' +
      'value that landed in its busiest single minute. Near 1 means one burst, which moves a book; ' +
      'evenly spread does not. Also reports which side dominated.',
    inputSchema: {
      symbol: SYMBOL,
      minutes: z.number().int().min(5).max(240).default(60).describe('Window length in minutes, 5 to 240.'),
    },
  },
  async ({ symbol, minutes }) =>
    callPaid(compiled.find((e) => e.id === 'liquidation_cascade'), { symbol, minutes }),
);

server.registerTool(
  'liquidation_universe',
  {
    title: 'Every symbol this tape saw in a window',
    description:
      'Paid, 0.10 USDC. The full symbol universe with row counts, so a caller can tell coverage ' +
      'from silence before drawing conclusions from an empty result.',
    inputSchema: {
      hours: z.number().int().min(1).max(168).default(24).describe('Window length in hours, 1 to 168.'),
    },
  },
  async ({ hours }) => callPaid(compiled.find((e) => e.id === 'liquidation_universe'), { hours }),
);

server.registerTool(
  'venue_integrity',
  {
    title: 'Per exchange reporting integrity',
    description:
      'Paid, 0.03 USDC. Row and symbol counts per exchange for the window, with which venues ' +
      'throttle their feeds. Two of the three emit at most one update per symbol per second and ' +
      'therefore undercount during exactly the cascades worth measuring.',
    inputSchema: {
      hours: z.number().int().min(1).max(168).default(24).describe('Window length in hours, 1 to 168.'),
    },
  },
  async ({ hours }) => callPaid(compiled.find((e) => e.id === 'venue_integrity'), { hours }),
);

await server.connect(new StdioServerTransport());
