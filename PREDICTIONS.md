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

Not yet recorded. Both predictions will be checked after the listing payments
and the outcome written here.
