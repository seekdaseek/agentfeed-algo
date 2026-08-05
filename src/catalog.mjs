/**
 * The catalog.
 *
 * One array is the single source of truth for what is sold, at what price, and
 * how it is described. The x402 routes config, the public manifest, the CLI
 * listing and the tests all derive from it.
 *
 * This is deliberate. The failure I have hit repeatedly in this kind of service
 * is drift: a price changed in the middleware but not in the docs, or a tool
 * added to the server but missing from the manifest, so the count in the README
 * slowly becomes fiction. Anything derived cannot drift.
 */

import { toMicroUsdc } from './money.mjs';

/**
 * @typedef {object} CatalogEntry
 * @property {string} id            stable identifier, used in the ledger
 * @property {string} path          express path, must start with /
 * @property {string} price         human readable USDC price
 * @property {string} description   what the payment unlocks, in one sentence
 * @property {string[]} tags        discovery tags
 * @property {string} [query]       documented query parameters
 */

/** @type {CatalogEntry[]} */
export const CATALOG = [
  {
    id: 'liquidation_window',
    path: '/v1/liquidations/window',
    price: '0.02',
    description:
      'Forced liquidation volume for one symbol over a recent window, split by exchange and by whether longs or shorts were liquidated.',
    tags: ['derivatives', 'liquidations', 'market-data'],
    query: 'symbol, hours (1 to 168)',
    input: { symbol: 'SOL', hours: '24' },
  },
  {
    id: 'liquidation_cascade',
    path: '/v1/liquidations/cascade',
    price: '0.05',
    description:
      'Cascade score for one symbol: whether current liquidation volume is clustered rather than spread, with the observation window it was computed over.',
    tags: ['derivatives', 'liquidations', 'signal'],
    query: 'symbol, minutes (5 to 240)',
    input: { symbol: 'BTC', minutes: '60' },
  },
  {
    id: 'liquidation_universe',
    path: '/v1/liquidations/universe',
    price: '0.10',
    description:
      'Every symbol seen on the tape in a window, with row counts, so a caller can tell coverage from silence.',
    tags: ['derivatives', 'liquidations', 'coverage'],
    query: 'hours (1 to 168)',
    input: { hours: '24' },
  },
  {
    id: 'venue_integrity',
    path: '/v1/venues/integrity',
    price: '0.03',
    description:
      'Per exchange reporting integrity for the window: row counts, distinct symbols, and which exchanges undercount by design.',
    tags: ['derivatives', 'data-quality', 'venues'],
    query: 'hours (1 to 168)',
    input: { hours: '24' },
  },
];

/**
 * The tag the Global x402 Challenge requires on every entered endpoint.
 *
 * It is a qualification condition, not decoration: the organisers use it to
 * find entered endpoints in the Bazaar. Applied to every route by
 * compileCatalog, so it cannot be forgotten on one of them.
 */
export const CHALLENGE_TAG = 'x402-global-challenge';

/** Free routes. They exist to make the paid ones legible before anyone pays. */
export const FREE_ROUTES = Object.freeze(['/health', '/catalog', '/.well-known/x402']);

export class CatalogError extends Error {}

/**
 * Validate the catalog and return it with prices resolved to BigInt base units.
 * Called at startup and by the preflight, so a bad entry can never reach a route.
 */
export function compileCatalog(catalog = CATALOG) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new CatalogError('catalog is empty; a paid API with no paid routes is a mistake');
  }

  const seenIds = new Set();
  const seenPaths = new Set();

  return catalog.map((entry) => {
    for (const field of ['id', 'path', 'price', 'description']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new CatalogError(`catalog entry ${entry.id ?? '(unnamed)'} is missing "${field}"`);
      }
    }
    if (!/^[a-z][a-z0-9_]*$/.test(entry.id)) {
      throw new CatalogError(`catalog id "${entry.id}" must be lower snake case`);
    }
    if (seenIds.has(entry.id)) throw new CatalogError(`duplicate catalog id "${entry.id}"`);
    seenIds.add(entry.id);

    if (!entry.path.startsWith('/')) {
      throw new CatalogError(`catalog path "${entry.path}" must start with /`);
    }
    if (seenPaths.has(entry.path)) throw new CatalogError(`duplicate catalog path "${entry.path}"`);
    if (FREE_ROUTES.includes(entry.path)) {
      throw new CatalogError(`catalog path "${entry.path}" collides with a free route`);
    }
    seenPaths.add(entry.path);

    let micro;
    try {
      micro = toMicroUsdc(entry.price);
    } catch (err) {
      throw new CatalogError(`catalog entry "${entry.id}" has an unusable price: ${err.message}`);
    }
    if (micro <= 0n) {
      throw new CatalogError(`catalog entry "${entry.id}" is priced at zero; use a free route instead`);
    }

    if (!Array.isArray(entry.tags) || entry.tags.length === 0) {
      throw new CatalogError(`catalog entry "${entry.id}" needs at least one tag for discovery`);
    }
    if (entry.description.length > 300) {
      throw new CatalogError(`catalog entry "${entry.id}" description is over 300 characters`);
    }

    const tags = [...entry.tags];
    if (!tags.includes(CHALLENGE_TAG)) tags.push(CHALLENGE_TAG);

    return Object.freeze({ ...entry, micro, tags: Object.freeze(tags) });
  });
}

/** Total cost of calling every paid route once. A single honest headline number. */
export function sweepPrice(compiled) {
  return compiled.reduce((acc, e) => acc + e.micro, 0n);
}
