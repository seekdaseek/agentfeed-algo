# agentfeed-algo

A paid x402 data API on Algorand. It sells a cross venue liquidation tape per call in USDC, and it tells you when it does not know.

Built for the Algorand Foundation Global x402 Challenge.

## Live on Algorand mainnet

    https://algo.ochinimus.app

    network   algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k
    asset     USDC, ASA 31566704
    facilitator  https://facilitator.goplausible.xyz
    catalog   https://algo.ochinimus.app/catalog
    manifest  https://algo.ochinimus.app/.well-known/x402

Free to inspect, paid to read. Call any route without payment and you get a 402 carrying the price, the asset and what the payment unlocks. The tape behind it currently covers around 710 symbols and 50,000 liquidation rows per day across Binance, Bybit and OKX.

## What it sells

Four endpoints, priced in USDC, paid per request over x402 with no account, no API key and no signup.

Liquidation volume for one symbol over a window, split by exchange and by whether longs or shorts were liquidated, at 0.02 USDC.
A cascade score, which measures whether that volume arrived as a single burst or spread evenly, at 0.05.
The full symbol universe the tape saw in a window, so a caller can tell coverage from silence, at 0.10.
Per exchange reporting integrity, at 0.03.

Calling every route once costs 0.2 USDC. That number is computed from the catalog, not typed into the README, so it cannot drift.

## Global x402 Challenge qualification

Entered as a Composite project: four endpoints under one project sharing a single payTo address.

Every route carries the required `x402-global-challenge` tag and declares a Bazaar discovery extension, so an agent that has never heard of this service can find it, read what each route costs, and construct a valid request from the listing alone. Both are applied in `compileCatalog` and `buildRoutes` rather than written per route, so neither can be forgotten on one endpoint, and there are tests asserting all four carry them.

Settlement runs through the GoPlausible facilitator on Algorand mainnet. Two payments have completed end to end.

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

One honest note about the hooks that feed it. The exact shape of the context object x402 hands to onAfterSettle is not something I have observed against a live facilitator yet. Rather than assert a shape I have not seen, the extractor tries the plausible field paths, and when it cannot find a payer it records the context's top level keys instead of writing a null. The first real settlement therefore teaches us the shape, in the ledger, where somebody will read it.

## Architecture

The catalog is one array and everything derives from it. The x402 routes config, the public manifest at /.well-known/x402, the free /catalog listing, the CLI output and the tests all read the same source, so a price cannot be changed in one place and stale in another.

The tape store is injected. Tests run against an array in memory and never open a file, which is also why a missing tape degrades to unmeasured rather than to a crash.

The facilitator client is injected. Tests never touch the network.

## Tests

```
npm test
```

No network, no wall clock, no sleeps. The end to end suites start the real Express app on an ephemeral port and drive it over real HTTP, including with the paywall engaged, so the 402 path is proven rather than assumed.

## Symbols are exchange pairs, and a coverage gap is not a quiet market

The tape stores SOLUSDT, not SOL. A caller who asks for SOL and gets zero rows must not be told "no liquidations for SOL", because that is a finding and it is false; the truth is that we never carried a symbol by that name.

So resolution happens first. A bare symbol is tried against USDT, USD and USDC suffixes, the resolved pair and the resolution method are both returned, and a symbol this tape does not carry comes back unmeasured with the reason symbol_not_covered. Unmeasured is not billed, so a coverage gap costs the caller nothing and never enters their reasoning as a market fact.

A symbol the tape does carry, with an empty window, is absent. That one is a real finding about a quiet market and is billed normally.

## The facilitator advertises a different network identifier than the client library

Worth knowing before you debug this yourself. CAIP-2 caps the chain reference at 32 characters, and the @x402/avm package constants follow that. The GoPlausible facilitator advertises Algorand with the full 44 character base64 genesis hash instead, padding included, while advertising Solana correctly truncated in the same response.

This breaks two separate things, and the second one is worse.

The preflight compares the two forms and reports a false negative that reads as "the facilitator does not support your network". On mainnet that would stop the service from starting for a reason that is not real.

Worse, @x402/core does the same plain string comparison inside its own capability check. Every paid route then fails to build a payment challenge and the service answers 503 instead of 402. In production that means nobody can pay you and the endpoint is inert. The error reads: Facilitator does not support scheme exact on network algorand followed by the truncated identifier.

The fix is not to configure the long form. That would satisfy the string comparison and break asset resolution instead, because USDC_CONFIG in @x402/avm has no key for the untruncated identifier.

What makes this an upstream bug rather than a configuration mistake is that @x402/avm already knows how to reconcile the two. normalizeAlgorandNetwork accepts either form and returns the canonical one, isAlgorandNetwork accepts both, and getNetworkFromCaip2 resolves both to testnet or mainnet correctly. The mechanism package handles it. The core capability check simply never asks.

So this service normalises at the facilitator boundary, wrapping the client so that getSupported returns canonical identifiers before core ever sees them, using the library's own normaliser rather than a hand rolled one. verify and settle pass through untouched. There is a test that reproduces the exact failure with the facilitator's real payload shape and asserts a 402 comes back rather than a 503, so the day core fixes this upstream, the tests will still pass and the wrapper can be deleted.

If you are building on Algorand x402 and your paid routes answer 503, this is why.

## Known limitation in the ledger

The ledger writes from the resource server's verify and settle hooks. A request that fails before verification is reached, such as a malformed payment header, produces no ledger line at all. The facilitator and the chain remain the authoritative record; this file is our copy of it, and it is complete only for payments that got as far as being checked.

## Limitations

The tape reader expects a liquidations table with symbol, venue, ts in milliseconds and usd columns. If your schema differs, the store is the only thing that has to change.

The ledger is a local file. It is our copy of the truth, not the truth, which lives with the facilitator and on chain.

Cascade concentration is computed over one minute buckets. That is a reasonable resolution for perpetual liquidations and an arbitrary one for anything else.

Only the exact scheme is registered. Other schemes would need their own server implementation.

## Licence

MIT.
