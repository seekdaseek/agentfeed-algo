# agentfeed-algo

A paid x402 data API on Algorand. It sells a cross venue liquidation tape per call in USDC, and it tells you when it does not know.

Built for the Algorand Foundation Global x402 Challenge.

## Live on Algorand mainnet

    https://algo.ochinimus.app

    network   algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=
    asset     USDC, ASA 31566704
    facilitator  https://facilitator.goplausible.xyz
    catalog   https://algo.ochinimus.app/catalog
    manifest  https://algo.ochinimus.app/.well-known/x402

Free to inspect, paid to read. Call any route without payment and you get a 402 whose body carries the route, the price, the asset and what the payment unlocks, with the payment challenge itself base64 in the PAYMENT-REQUIRED header. The tape behind it has recorded close to 900 symbols on Binance, Bybit and OKX since July 8 2026, and it adds around 80,000 liquidation rows a day.

## What it sells

Five endpoints, priced in USDC, paid per request over x402 with no account, no API key and no signup. They are published under /v2.

The five paths these routes were first published under, the /v1 ones, still answer. Same handlers, same paywall, same prices, each with its own resource URL. An agent holding an old URL is not broken by the move. Nothing advertises /v1 any more, though: the catalog, the manifest, the landing page and the MCP server list only /v2, and nothing new should be built against the old paths.

Liquidation volume for one symbol over a window, split by exchange and by whether longs or shorts were liquidated, at 0.02 USDC.
A cascade score, which measures whether that volume arrived as a single burst or spread evenly, at 0.05.
The full symbol universe the tape saw in a window, so a caller can tell coverage from silence, at 0.10.
Per exchange reporting integrity, at 0.03.

The fifth route sells history. It returns the complete recorded liquidation history for one symbol across all three exchanges, from that symbol's first observation on this tape through to now, bucketed hourly or daily, at 5.00. No other route here looks back further than seven days, and that is the whole difference: a liquidation record cannot be backfilled after the fact, so depth is the part that is genuinely scarce. Coverage is stated per symbol rather than per tape, because a symbol first appears whenever it first liquidated, which can be weeks after the tape itself began, and the payload carries that symbol's own coverage start so our start date is never mistaken for the market's.

Calling every route once costs 5.2 USDC. The live figure is published at /catalog as sweep_price_usdc and is computed from the catalog rather than typed, so if this line ever disagrees with it, the endpoint is right and this file is stale.

## Global x402 Challenge qualification

Entered as a Composite project: five endpoints under one payTo address.

Every route carries the required `x402-global-challenge` tag and declares a Bazaar discovery extension, so an agent that has never heard of this service can find it, read what each route costs, and construct a valid request from the listing alone. Both are applied in `compileCatalog` and `buildRoutes` rather than written per route, so neither can be forgotten on one endpoint, and the tests that check them iterate over every route the service answers on rather than sampling one, so a route that lost either would fail the suite.

The tag rides in `accepts[].extra`, which is where the leaderboard reads it, not in `resource.tags`. It travels there alongside the asset decimals and the feePayer the facilitator advertises, because `ExactAvmScheme` merges that extra rather than replacing it.

Settlement runs through the GoPlausible facilitator on Algorand mainnet, and payments have completed end to end. The current count, the distinct payers behind it and the settled total are whatever the ledger says rather than whatever this file says, so read them with `agentfeed-algo ledger` instead of trusting a number typed here.

## Use it from an agent

The endpoint is a URL, which is invisible to the thing meant to pay for it. So this ships an MCP server too.

    npx -y @seekdaseek/agentfeed-algo-mcp

Or in an MCP client config, as a server named agentfeed-algo running `npx -y @seekdaseek/agentfeed-algo` with the binary `agentfeed-algo-mcp`, and one environment variable, `ALGO_PAYER_MNEMONIC`, holding the mnemonic for an Algorand account that has USDC and is opted in to asset 31566704.

Six tools. Four are paid, one for each of the short window routes. Two are free: `catalog` lists everything sold and what it costs, and `payer_status` reports your balances and anything blocking payment. Both work with no key at all, so you can install this, look at what exists, and decide afterwards whether to fund anything. The history route is listed by the `catalog` tool, with its price and its path, but it has no tool of its own.

Payment comes from your own account. There is no key of ours in the loop and no account to create.

An unmeasured response comes back as a tool error rather than as data. The HTTP layer already refuses to bill it, but an agent reading a tool result needs the same signal, and a hole that looks like an answer is worse than no answer.

## The thing that makes it worth paying for

Every response carries its own status, and there are three of them.

Measured means we asked and got an answer.

Absent means we asked and the market had none. No liquidations in the window is a real finding about a quiet market, and a buyer can act on it.

Unmeasured means our own lookup failed. A rate limit, a locked database, a query that threw. This is not a finding, it is the absence of one.

An unmeasured response returns 503 and is never billed, even though payment was already verified by the time we find out. That costs us the sale on purpose. Once an agent is paying per call, the worst product you can sell is a zero you invented, because the caller has no way to tell it from a real one. A feed that says when it does not know is worth more per call than one that always answers.

## Running it

```
npm install
npm test
node bin/agentfeed-algo.mjs catalog
```

Configuration is environment driven. Copy the example and fill it in.

```
cp .env.example .env
node bin/agentfeed-algo.mjs doctor
node bin/agentfeed-algo.mjs serve
```

Doctor checks the config, the catalog and the facilitator, and prints a line per check. Serve refuses to start if any of them failed.

## Mainnet is never an accident

The deployment above runs on mainnet. Getting there takes two deliberate variables, ALGO_NETWORK set to mainnet and ALGO_ALLOW_MAINNET set to yes, and an unset config falls back to testnet rather than forward to mainnet.

That is on purpose. One mistyped variable should not be enough to start taking real money, and a service that quietly defaults into handling funds will eventually take payments to an address nobody checked.

On mainnet the preflight also refuses a localhost resource URL, a plaintext facilitator, a testnet asset id, and any warning at all. On testnet warnings are allowed through. The asymmetry is the point: on mainnet a misconfiguration sends money somewhere with no undo.

## The payTo address is checksummed, not pattern matched

An Algorand address is base32 over a 32 byte public key plus a 4 byte SHA-512/256 checksum. A regular expression that checks length and alphabet will happily accept two transposed characters. The checksum will not, and there is a test that transposes a pair to prove it.

This is the one field where a typo costs real money silently, so it gets a real decoder rather than a pattern.

## Prices are BigInt, always

USDC has six decimals. Every price in this service is a BigInt count of microUSDC and never a float. A price with more precision than the asset can express is an error rather than something to quietly shorten, so toMicroUsdc("0.0000001") throws instead of becoming zero.

The x402 price field is passed as an asset amount, carrying the asset id explicitly, so a decimal can never be interpreted against the wrong token.

## Who is paying

The challenge asks entrants for proof of who is paying, and a leaderboard total cannot answer that. Ten agents paying twenty times each and one agent paying two hundred times produce the same total and are completely different businesses.

So every verify and every settle, successful or not, is appended to a local ledger, and the summary leads with concentration rather than with the total.

```
node bin/agentfeed-algo.mjs ledger
```

One note about the hooks that feed it. The shape of the context object x402 hands to onAfterSettle was not something I had observed when this was written, so rather than assert a shape I had not seen, the extractor tries the plausible field paths, and when it cannot find a payer it records the context's top level keys instead of writing a null. The first real settlement, on 2026-08-05, taught us the shape in the ledger where somebody would read it: the context carries paymentPayload, requirements, declaredExtensions, transportContext and result, with the payer and the transaction id under result. The extractor still tries the other paths, because that costs nothing and the shape is upstream's to change.

## Architecture

The catalog is one array and everything derives from it. The x402 routes config, the public manifest at /.well-known/x402, the free /catalog listing, the CLI output and the tests all read the same source, so a price cannot be changed in one place and stale in another.

The tape store is injected. Tests run against an array in memory and never open a file, which is also why a missing tape degrades to unmeasured rather than to a crash.

The facilitator client is injected. Tests never touch the network.

## Tests

```
npm test
```

No network, no wall clock, no sleeps. The end to end suites start the real Express app on an ephemeral port and drive it over real HTTP, including with the paywall engaged, so the 402 path is proven rather than assumed.

The route tests go through HTTP as well, and that is not decoration. A handler level test cannot see a query parameter the server never passes, and one that was never passed is exactly how the history route came to ignore its bucket parameter: the handler validated bucket and defaulted it to hourly, its own tests passed, and the server was calling it without the parameter at all. So bucket=day was quietly answered hourly, and an invalid bucket was answered hourly and billed, when the handler would have refused it as unmeasured and charged nothing. The seam between the router and the handler is where that lived, so that is where the tests for it sit now.

## Symbols are exchange pairs, and a coverage gap is not a quiet market

The tape stores SOLUSDT, not SOL. A caller who asks for SOL and gets zero rows must not be told "no liquidations for SOL", because that is a finding and it is false; the truth is that we never carried a symbol by that name.

So resolution happens first. A bare symbol is tried against USDT, USD and USDC suffixes, the resolved pair and the resolution method are both returned, and a symbol this tape does not carry comes back unmeasured with the reason symbol_not_covered. Unmeasured is not billed, so a coverage gap costs the caller nothing and never enters their reasoning as a market fact.

A symbol the tape does carry, with an empty window, is absent. That one is a real finding about a quiet market and is billed normally.

## The facilitator advertises a different network identifier than the client library

Worth knowing before you debug this yourself. CAIP-2 caps the chain reference at 32 characters, and the @x402/avm package constants follow that. The GoPlausible facilitator advertises Algorand with the full 44 character base64 genesis hash instead, padding included, while advertising Solana correctly truncated in the same response.

This breaks two separate things, and the second one is worse.

The preflight compares the two forms and reports a false negative that reads as "the facilitator does not support your network". On mainnet that would stop the service from starting for a reason that is not real.

Worse, @x402/core does the same plain string comparison inside its own capability check. Every paid route then fails to build a payment challenge and the service answers 503 instead of 402. In production that means nobody can pay you and the endpoint is inert. The error reads: Facilitator does not support scheme exact on network algorand followed by the truncated identifier.

The first fix here was to normalise at the boundary, wrapping the facilitator client so that getSupported returned truncated identifiers before core ever saw them. That satisfied the capability check and then failed one step later, at verify time, because the facilitator validates a payment against the identifier it advertises, which is the untruncated one. A challenge built on the truncated form comes back as Network not supported, after the caller has already signed. That is a worse place to fail than startup.

So the config carries the untruncated identifier, the one the facilitator itself validates against, and nothing on the payment path rewrites it.

The objection to doing that is asset resolution, because USDC_CONFIG in @x402/avm has no key for the untruncated identifier. It does not bite here, because the price is never handed over as a decimal to be resolved against a network keyed table. It is passed as an asset amount carrying the ASA id explicitly, and parsePrice in @x402/avm returns that amount and asset untouched rather than consulting USDC_CONFIG at all. The lookup that would have broken is never reached.

What makes this an upstream bug rather than a configuration mistake is that @x402/avm already knows how to reconcile the two forms. normalizeAlgorandNetwork accepts either and returns the canonical one, isAlgorandNetwork accepts both, and getNetworkFromCaip2 resolves both to testnet or mainnet correctly. The mechanism package handles it. The core capability check simply never asks.

The normaliser is still in the tree and still tested, because the preflight compares defensively and because the day core reconciles the two forms upstream, the tests should say so rather than go quiet. There is a test that replays the facilitator's real payload shape and asserts a 402 comes back rather than a 503.

If you are building on Algorand x402 and your paid routes answer 503, this is why.

## Known limitation in the ledger

The ledger writes from the resource server's verify and settle hooks. A request that fails before verification is reached, such as a malformed payment header, produces no ledger line at all. The facilitator and the chain remain the authoritative record; this file is our copy of it, and it is complete only for payments that got as far as being checked.

There is a second gap, and it is ours rather than upstream's. Every entry written so far carries a null routeId and a null path, so the ledger can say who paid, how much, and with which transaction, but not which route they bought. The extractor looks for the resource URL under requirements.resource and the other plausible keys, and on the live contexts it has not found one. Payer concentration, which is the question the ledger exists to answer, is unaffected. Per route revenue is not available from this file today.

## Limitations

The tape reader expects a liquidations table with symbol, exchange, side, ts in milliseconds and usd columns. The column is exchange rather than venue, and symbols are exchange pairs such as SOLUSDT rather than bare tickers. If your schema differs, the store is the only thing that has to change.

The ledger is a local file. It is our copy of the truth, not the truth, which lives with the facilitator and on chain.

Cascade concentration is computed over one minute buckets. That is a reasonable resolution for perpetual liquidations and an arbitrary one for anything else.

Only the exact scheme is registered. Other schemes would need their own server implementation.

## Licence

MIT.
