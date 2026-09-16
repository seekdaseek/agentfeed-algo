# Predictions

Written 2026-09-16, before the calls that settle them.

These are recorded in advance because a prediction written after the result is
not a prediction. Each one names what will happen, and why it will happen, in
enough detail that a wrong answer is obvious rather than arguable. Both will be
checked against the live service, and the outcome of each will be written back
into this file either way, including if it contradicts what is written here.

## 1. A paid call for a symbol we do not carry is refused and not charged

Prediction. A fully paid call to /v2/liquidations/window for the symbol NOTACOIN
will come back with HTTP status 503 and an envelope whose status is unmeasured
and whose failure reason is symbol_not_covered. The response will carry no
PAYMENT-RESPONSE header. No settlement transaction will exist for it on chain.
The paying account's USDC balance will be the same after the call as before it.

Why. Two mechanisms have to line up, and they sit in different places.

The first is ours. src/tape.mjs resolves a caller's symbol against the tape
before it queries anything, and a symbol the tape has never carried comes back
as unmeasured with the reason symbol_not_covered, rather than as an empty market.
src/server.mjs then answers 503 rather than 200 for any envelope that is not
billable, even though the payment has already been verified by that point.

The second is the library's. @x402/express 2.21.0 buffers the route handler's
response, and once the handler has finished it checks the response status. On
any status of 400 or above it cancels the verified payment instead of settling
it, replays the buffered response, and returns before the settle call is ever
reached. Settlement is therefore never requested from the facilitator, and the
header that would carry a settlement transaction is never attached.

So the refusal is not a refund. Nothing is taken and then given back. The money
is never moved, because the only code path that moves it is skipped.

What would falsify this. A 200 instead of a 503. An envelope with status
measured or absent for a symbol the tape does not carry. A PAYMENT-RESPONSE
header on the reply. Any settlement transaction against that call. Any drop in
the payer's USDC balance.

## 2. A fresh resource URL lists in the Bazaar with the full extra

Prediction. The first settlement against each new /v2 path will create a Bazaar
record whose accepts extra carries all three of feePayer, decimals and tag, and
those records will be returned by a search filtered on the tag
x402-global-challenge.

Why. A Bazaar record is written once, at the first settlement against a resource
URL, and its accepts are never re-read afterwards. Whatever the payment
requirements carried at that first moment is what the listing carries for good.

That is exactly why the four original routes are not findable by tag today. They
were first paid on 2026-08-05, before the tag was added to accepts extra, so
their records hold feePayer alone and a tag filtered search cannot see them.
Editing the running service does not fix them, because nothing goes back and
re-reads a record that already exists. Records first settled after the tag was
set do carry the tag, which is the evidence this prediction rests on.

The /v2 paths have never been settled against. They will carry the tag and the
decimals from their very first payment, so the record written at that moment
should hold feePayer, decimals and tag together.

This one is inference from how the existing records differ, not something
already observed on a new URL. That is precisely why it is written down before
the calls rather than after them.

What would falsify this. A record whose extra is missing any of the three keys.
A record that exists but does not come back under the tag filter. No record at
all for a path that settled successfully.

## Results

### Prediction 2, checked 2026-09-16. Half confirmed, half not testable

Three /v2 paths were paid on mainnet on 2026-09-16 at around 11:34 UTC:
liquidations/cascade, liquidations/universe and venues/integrity. All three
settled. Reading the GoPlausible discovery listing straight afterwards gives
this, for every record the Bazaar holds for algo.ochinimus.app:

    path                        accepts extra           settleCount  firstSeen
    /v1/liquidations/window     feePayer                3            2026-08-05T14:08:58Z
    /v1/liquidations/cascade    feePayer                1            2026-08-05T14:09:01Z
    /v1/liquidations/universe   feePayer                1            2026-08-05T14:05:07Z
    /v1/venues/integrity        feePayer                2            2026-08-05T14:09:03Z
    /v2/liquidations/cascade    decimals, feePayer, tag 1            2026-09-16T11:34:23Z
    /v2/liquidations/universe   decimals, feePayer, tag 1            2026-09-16T11:34:37Z
    /v2/venues/integrity        decimals, feePayer, tag 1            2026-09-16T11:34:53Z

The first claim is confirmed exactly as written. Each new /v2 path created a
record on its first settlement, and each of those records carries all three of
feePayer, decimals and tag. The four /v1 records, written on 2026-08-05 before
the tag existed in accepts extra, still carry feePayer alone after seven
further settlements between them, which is the write once behaviour this
prediction rested on, observed rather than assumed.

/v2/liquidations/window and /v2/liquidations/history have no record, because
neither has been paid yet. That is consistent: a record appears at first
settlement and not before.

The second claim cannot be tested at this endpoint, and the reason matters more
than the result. The tag parameter on the discovery endpoint does not filter.
Asking for tag=x402-global-challenge returns 2024 records. Asking for a tag
that cannot exist, tag=definitely-not-a-real-tag-zzz9, returns the same 2024
records. So does asking with no tag parameter at all. The parameter is ignored.

That means the literal wording of the prediction, that the new records would be
returned by a search filtered on the tag, is technically true and worthless.
They are returned, but so is everything else, including our own four /v1
records which demonstrably do not carry the tag. A filter that returns
everything cannot be evidence that anything passed it.

Other parameter spellings were tried. tags, q, filter, type and extra.tag all
return the full 2024. search does filter, but it is a text search over the
record rather than a lookup on accepts extra: search=x402-global-challenge
returns exactly one record, a different merchant whose description contains
that string, and not our three records that genuinely carry the tag in the
place the challenge specifies. search=algo.ochinimus.app returns all seven of
ours.

So the useful conclusion is narrower than the prediction and more useful than
it. What we control is confirmed: a fresh resource URL stores the full extra on
its first settlement, and an old one cannot be repaired. What we assumed about
discovery is wrong: the public discovery endpoint offers no way to filter on
accepts extra tag today, so whatever the leaderboard reads, it is not this
parameter. The premise that a tag filtered search was missing our /v1 records
does not hold up against this endpoint, because that search is not filtering at
all.

### Prediction 1, not yet checked

No call has been made for NOTACOIN or any other uncovered symbol, so this one
stands open and unmodified. One piece of supporting evidence arrived on its
own: the settlement ledger holds four canceled events, which is the hook that
fires when x402 cancels a verified payment instead of settling it, so the
cancel path this prediction depends on has already run in production. That is
corroboration of the mechanism and not a test of the prediction. The result
will be written here when the call is made.
