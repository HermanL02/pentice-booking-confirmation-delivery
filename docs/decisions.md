# Decision records

Short records of the calls made while building this service. Each one says
what problem forced the call, what was chosen, what it costs, and how to undo
it if a requirement changes. The brief left several points open; Herman
decided them without asking Pentice (spec section 13), and they are recorded
here alongside the builder's calls.

1. [Transactional outbox instead of a message queue](#1-transactional-outbox-instead-of-a-message-queue)
2. [Retries never stop; no automatic dead-letter](#2-retries-never-stop-no-automatic-dead-letter)
3. [Whole-file JSON snapshots instead of an append log](#3-whole-file-json-snapshots-instead-of-an-append-log)
4. [Guest device simulator runs in the same process](#4-guest-device-simulator-runs-in-the-same-process)
5. [Redis excluded; Google Pub/Sub is an optional transport](#5-redis-excluded-google-pubsub-is-an-optional-transport)
6. [The outbox owns backoff on every transport](#6-the-outbox-owns-backoff-on-every-transport)
7. [`forbidNonWhitelisted` is on](#7-forbidnonwhitelisted-is-on)
8. [Confirmation codes are case-insensitive](#8-confirmation-codes-are-case-insensitive)
9. [Unknown code returns 404 with a JSON body](#9-unknown-code-returns-404-with-a-json-body)
10. [`POST /bookings` returns 202 without the code](#10-post-bookings-returns-202-without-the-code)
11. [Repeat `POST /bookings`: same guest 200, different guest 409](#11-repeat-post-bookings-same-guest-200-different-guest-409)
12. [An expired lease counts as an attempt; a released lease does not](#12-an-expired-lease-counts-as-an-attempt-a-released-lease-does-not)
13. [OpenTelemetry dropped; Sentry and BetterStack env-gated](#13-opentelemetry-dropped-sentry-and-betterstack-env-gated)
14. [An outcome after the ack is counted; ack never reopens](#14-an-outcome-after-the-ack-is-counted-ack-never-reopens)

---

## 1. Transactional outbox instead of a message queue

**Context.** A booking and the obligation to deliver its confirmation must
never come apart. If the booking is saved and the process dies before a
message is enqueued, the guest never hears back. If the message is enqueued
and the booking write fails, the guest receives a code that resolves to
nothing. Two systems (a store and a queue) cannot be written atomically
without a distributed transaction.

**Decision.** The booking, its code index entry and its outbox record are
written in one storage mutation (`BookingsService.create` inside
`FileStore.mutate`). A dispatcher drains the outbox on a 1 s tick, plus an
immediate attempt triggered by the `booking.created` event. The outbox record
is the only durable source of truth for delivery state.

**Consequences.** No window exists in which one side exists without the
other. Delivery state is inspectable in one place (`GET /deliveries`). The
cost is polling: a tick every `DELIVERY_TICK_MS`, and first-attempt latency
relies on the event, with the tick as the fallback.

**How to reverse.** Make `BookingsService.create` publish to a broker after
the write and accept the gap, or keep the outbox and relay it to a broker
(the Pub/Sub transport already does the latter).

## 2. Retries never stop; no automatic dead-letter

**Context.** The brief says the server keeps trying until the guest
acknowledges, with no giving up. A dead-letter queue is the usual safety
valve, but parking a confirmation automatically is a form of giving up.

**Decision.** There is no maximum attempt count. Backoff is exponential with
full jitter, capped at `DELIVERY_BACKOFF_MAX_MS` (5 minutes). After
`DELIVERY_ATTENTION_AFTER_ATTEMPTS` (10) the record is flagged
`needsAttention`, logged at error level and sent to Sentry when configured.
It keeps retrying.

**Consequences.** A guest who is unreachable for days costs one attempt
every five minutes or less, forever. Operators see these records through
`GET /deliveries?attention=true` and `/metrics` `needsAttention`, and can
force an attempt with `retry-now`. The outbox grows with every undeliverable
booking; at this scale that is acceptable.

**How to reverse.** Add `DELIVERY_MAX_ATTEMPTS`, a `dead` status set in
`OutboxService.applyOutcome`, exclude it in `isClaimable`, and add an ops
endpoint to replay a dead record (spec section 11).

## 3. Whole-file JSON snapshots instead of an append log

**Context.** No database is allowed. The store must survive a crash at any
point and every read and write must be asynchronous.

**Decision.** `FileStore` keeps the whole state in one JSON document. Every
mutation runs under an `async-mutex`, writes the full state to
`store.json.tmp`, `fsync`s it and renames it over `store.json`. Reads return
a deep copy of the cache.

**Consequences.** The file on disk is always a complete state: a crash
leaves either the old or the new version, never a partial one. Recovery is
"read the file". Write cost grows with the number of bookings because every
mutation rewrites everything, and all writes are serialised. That is fine for
a challenge and for thousands of records; it is not a production store.

**How to reverse.** Implement `StoragePort` with an append-only log plus
periodic compaction, or (the real answer) a Postgres table. Callers only see
`read()` and `mutate()`, so nothing outside `src/storage/` changes.

## 4. Guest device simulator runs in the same process

**Context.** The brief forbids real external services but the delivery path
must cross a real network boundary to be honest about failures, timeouts and
lost acks.

**Decision.** `GuestDeviceModule` is a separate Nest module with no shared
providers. The booking side reaches it only over HTTP (`GUEST_DEVICE_INBOX_URL`)
and it acks only over HTTP (`ackUrl`). It can be switched offline (inbox
answers 503) or told to drop a fraction of messages (answers 200, does
nothing).

**Consequences.** One command runs the whole system, and the e2e tests
exercise real HTTP. The device's dedupe set and inbox are in memory on
purpose (the device is the unreliable side), so they are lost when the
process restarts; a real device must persist what it has seen.

**How to reverse.** Run the module as its own Nest app and point
`GUEST_DEVICE_INBOX_URL` and `PUBLIC_BASE_URL` at the two processes. No code
change.

## 5. Redis excluded; Google Pub/Sub is an optional transport

**Context.** The brief rules out a database but says nothing about message
brokers. Herman runs Google Pub/Sub in production and wanted the broker path
to be one he can defend from experience. A second broker would add a dependency with no new risk
covered.

**Decision.** Redis is not used anywhere. `PubSubTransport` is built and
enabled only when `PUBSUB_EMULATOR_HOST` is set; without it the webhook
transport is used. The transport is chosen once at boot, with no runtime
fallback.

**Consequences.** The core path needs no Docker, no gcloud and no
credentials. The Pub/Sub path is exercised by an integration spec that runs
in CI against the emulator. Two transports means two code paths to keep
aligned, which is why decision 6 exists.

**How to reverse.** Delete the Pub/Sub provider branch in
`transport.provider.ts` and its files; or add a Redis-backed transport behind
the same `DeliveryTransport` port.

## 6. The outbox owns backoff on every transport

**Context.** Pub/Sub has its own redelivery (ack deadlines, retry policy,
dead-letter topics). If both Pub/Sub and the outbox retried, attempts,
backoff and `needsAttention` would mean different things per transport and
deliveries could multiply.

**Decision.** There is exactly one retry loop: the outbox. `PubSubTransport`
returns `'handed-off'` and the dispatcher keeps the lease. The consumer
performs the webhook call, records the outcome through
`OutboxService.recordOutcome`, and always acks the Pub/Sub message, including
on failure, so Pub/Sub never redelivers on its own. A lost message shows up
as an expired lease, which counts as an attempt.

**Consequences.** `attempts`, `history`, backoff and `/metrics` mean the same
thing on both transports. Pub/Sub's own retry and dead-letter features are
deliberately unused.

**How to reverse.** Nack on failure and configure a subscription retry
policy, then remove backoff scheduling from the outbox for handed-off
records. Not recommended: it splits the retry authority.

## 7. `forbidNonWhitelisted` is on

**Context.** A global `ValidationPipe` with `whitelist` strips unknown fields
silently. A client sending `guestEmail` instead of `guest` would get a
confusing validation error at best, or a silently ignored field at worst.

**Decision.** `transform`, `whitelist` and `forbidNonWhitelisted` are all on
(`src/main.ts`). Unknown body fields return 400.

**Consequences.** Clients learn about typos immediately. Adding an optional
field to a payload requires adding it to the DTO first.

**How to reverse.** Set `forbidNonWhitelisted: false` in `main.ts`, or on a
per-route pipe for a partner payload that must tolerate extras.

## 8. Confirmation codes are case-insensitive

**Context.** Guests read codes off a phone and type them back. The brief
does not say whether `A2B34` and `a2b34` are the same code.

**Decision.** Codes are generated from lowercase `a-z0-9` and stored
lowercase. `ConfirmationCodePipe` lowercases the path parameter before
validating it against `^[a-z0-9]{5}$`.

**Consequences.** `GET /A2B34` and `GET /a2b34` resolve the same booking.
The code space is 36^5 = 60,466,176 rather than 62^5.

**How to reverse.** Add uppercase letters to `CODE_ALPHABET` in
`code-generator.ts` and drop the `toLowerCase()` calls in the pipe and
`BookingsService.findByCode`.

## 9. Unknown code returns 404 with a JSON body

**Context.** The brief requires `GET /:code` to return the booking, and says
nothing about what an unknown code should return.

**Decision.** `GET /:code` for an unknown code returns 404 with Nest's
default body, `{ "statusCode": 404, "message": "booking not found", "error":
"Not Found" }`. A malformed code (wrong length or characters) returns 400.

**Consequences.** Clients get a consistent error shape across the API and
can tell "not found" from "not a code".

**How to reverse.** Throw a custom exception or set the response with
`@Res()` in `BookingsController.findByCode`.

## 10. `POST /bookings` returns 202 without the code

**Context.** The brief says the confirmation is never in the `POST`
response; it must reach the guest out-of-band.

**Decision.** The first `POST /bookings` returns `202 Accepted` with
`{ reservationId, deliveryId, status: "pending" }`. 202 says the work is
accepted and will complete later; `deliveryId` lets an operator track it.

**Consequences.** The caller cannot learn the code from the API that
created it. Only the guest device (or an operator reading the store) sees it.

**How to reverse.** Return `confirmationCode` from `BookingsController.create`
and change the status to 201. This breaks the brief, so it would be a
requirement change.

## 11. Repeat `POST /bookings`: same guest 200, different guest 409

**Context.** Clients retry on timeouts. A retried `POST` must not create a
second booking or a second delivery. But a repeat with a different guest
contact could be a mistake that would send the code to the wrong person.

**Decision.** `POST /bookings` is idempotent on `reservationId`. A repeat
with the same `guest` returns `200` with the same `deliveryId`. A repeat
with a different `guest` returns `409`. The check runs inside the same
mutation as the create, so two concurrent identical requests yield one 202
and one 200.

**Consequences.** Retries are safe. Changing a guest's contact needs an
explicit endpoint (spec section 11: `PATCH /bookings/:reservationId/guest`).

**How to reverse.** Replace the 409 branch in `BookingsService.create` with
an update of the booking and its outbox record under the mutex.

## 12. An expired lease counts as an attempt; a released lease does not

**Context.** A claimed record carries `leaseUntil`. Two things can leave a
lease behind: the process died (or a handed-off message was lost) while a
send was in flight, or the dispatcher claimed records and then stopped before
sending them during a graceful shutdown.

**Decision.** In `claimDue`, a pending record whose lease has expired is
charged one attempt with outcome `lease-expired`, scheduled by the backoff
policy, and not reclaimed in the same call. On graceful shutdown, records
claimed but never sent are released with `releaseLease`: lease cleared, due
immediately, no attempt charged.

**Consequences.** A send that might have reached the guest is counted, so
`attempts` and the attention threshold stay honest. A shutdown never inflates
attempts for work that did not happen. After a hard kill, recovery waits up
to `DELIVERY_LEASE_MS` (15 s) for leases to expire.

**How to reverse.** Charge nothing on expiry by clearing `leaseUntil` in
`claimDue` without calling `applyOutcome`.

## 13. OpenTelemetry dropped; Sentry and BetterStack env-gated

**Context.** The job posting values observability, but the anti-goals forbid
scaffolding with no risk behind it. A single process with one outbox does
not need distributed tracing.

**Decision.** No OpenTelemetry. Structured logs via `nestjs-pino` with a
correlation id per request (set in pino-http's `genReqId`, so it is on the
request log line) and one line per delivery attempt; a JSON
`/metrics` snapshot; Sentry for the attention alert when `SENTRY_DSN` is set (in the
environment or `.env`: `instrument.ts` loads `.env` before it initialises the
SDK);
BetterStack log shipping when `BETTERSTACK_SOURCE_TOKEN` is set. Both are off
by default and the core path never needs them.

**Consequences.** Nothing external is required to run or test the service.
There are no traces across the Pub/Sub hop; the `deliveryId` in every log
line is the join key instead.

**How to reverse.** Add `@opentelemetry/sdk-node` in `instrument.ts` next to
Sentry and propagate the trace context in the Pub/Sub message attributes.

## 14. An outcome after the ack is counted; ack never reopens

**Context.** The device acks before its `200` reaches the dispatcher (or the
Pub/Sub consumer), so the ack can win the store mutex and the `sent` outcome
lands on an already-acked record. The same happens when a retry is in flight
at ack time. Dropping the late outcome left an acked record that showed
`attempts: 0` and an empty history although a send had happened.

**Decision.** `recordOutcome` on an `acked` record still appends the history
entry, increments `attempts` and sets `lastSentAt` for `sent`. It does not
change `status`, `leaseUntil` (left null), `nextAttemptAt` or
`needsAttention`, and raises no alert. Ack never reopens a delivery;
outcomes are still counted.

**Consequences.** `attempts` and `history` describe every send that
happened, in either order of ack and outcome, so the happy path always shows
exactly one attempt. An acked record can gain at most one attempt after the
ack: the lease allows one send at a time, and an acked record is never
claimed.

**How to reverse.** Return early for `acked` records in
`OutboxService.recordOutcome`, as before, and accept attempt counts that
depend on the race.

