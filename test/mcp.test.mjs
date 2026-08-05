import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs');

/**
 * Every test drives the real server over a real stdio transport with no payer
 * key, which is the state an operator is in the moment they install it. If the
 * free tools do not work there, nobody gets as far as funding an account.
 */
async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, ALGO_PAYER_MNEMONIC: '' },
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
}

test('the server exposes the free tools and one tool per paid route', async () => {
  const c = await connect();
  try {
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'catalog',
      'liquidation_cascade',
      'liquidation_universe',
      'liquidation_window',
      'payer_status',
      'venue_integrity',
    ]);
  } finally {
    await c.close();
  }
});

test('the catalog works with no key at all, so an operator can look before funding', async () => {
  const c = await connect();
  try {
    const res = await c.callTool({ name: 'catalog', arguments: {} });
    assert.notEqual(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.routes.length, 4);
    assert.equal(body.every_route_once_costs, '0.2 USDC');
    assert.ok(body.response_status_vocabulary.unmeasured.includes('never billed'));
    for (const r of body.routes) assert.ok(r.price_usdc && r.unlocks);
  } finally {
    await c.close();
  }
});

test('a missing key is an error that names the variable and the asset to opt into', async () => {
  const c = await connect();
  try {
    const res = await c.callTool({ name: 'payer_status', arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ALGO_PAYER_MNEMONIC/);
    assert.match(res.content[0].text, /31566704/);
  } finally {
    await c.close();
  }
});

test('a paid tool without a key fails cleanly rather than hanging or throwing', async () => {
  const c = await connect();
  try {
    const res = await c.callTool({ name: 'liquidation_window', arguments: { symbol: 'SOL', hours: 24 } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ALGO_PAYER_MNEMONIC/);
  } finally {
    await c.close();
  }
});

test('paid tools declare the parameters their route documents', async () => {
  const c = await connect();
  try {
    const tools = (await c.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(
      Object.keys(byName.liquidation_window.inputSchema.properties).sort(),
      ['hours', 'symbol'],
    );
    assert.deepEqual(
      Object.keys(byName.liquidation_cascade.inputSchema.properties).sort(),
      ['minutes', 'symbol'],
    );
    assert.deepEqual(Object.keys(byName.venue_integrity.inputSchema.properties), ['hours']);
  } finally {
    await c.close();
  }
});

test('every paid tool states its price in the description an agent reads', async () => {
  const c = await connect();
  try {
    const tools = (await c.listTools()).tools;
    for (const name of ['liquidation_window', 'liquidation_cascade', 'liquidation_universe', 'venue_integrity']) {
      const t = tools.find((x) => x.name === name);
      assert.match(t.description, /Paid, 0\.\d+ USDC/, `${name} does not state its price`);
    }
    for (const name of ['catalog', 'payer_status']) {
      assert.match(tools.find((x) => x.name === name).description, /^Free\./);
    }
  } finally {
    await c.close();
  }
});
