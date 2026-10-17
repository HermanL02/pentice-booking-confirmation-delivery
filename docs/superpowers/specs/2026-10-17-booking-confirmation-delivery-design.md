# Booking Confirmation Delivery — Design

Date: 2026-10-17
Owner: Herman Liang
Status: draft, awaiting approval

## 1. Intent

Pentice's code challenge: when a guest completes a booking, generate a unique
5-character confirmation code, persist it without a database, deliver it to the
guest out-of-band over a simulated channel, keep retrying until the guest's
device acknowledges it, never deliver the same confirmation twice, and resolve
`GET /:code` back to the booking.

The deliverable is judged in three ways (from the brief and the job posting):

1. Correctness of the delivery and persistence logic.
2. The defense: every decision must be explainable and defensible.
3. Live coding: a reviewer will change the requirements on this same codebase
   during the interview. The code must be easy to change without any setup.

This is built as if it were a production service at Pentice: a small,
reliable, observable system with clear boundaries, not a demo.

## 2. Goals, non-goals, anti-goals

Goals

- Exactly the API in the brief: `POST /bookings`, `GET /:code`.
- Crash-safe persistence to a file with asynchronous read/write.
- Delivery survives process restart, guest offline, and partial failures.
- Application-level exactly-once delivery to the guest.
- Operable: a reviewer can see pending deliveries, retries, and force a retry.
- Runs with one command, no Docker, no cloud credentials.
- Fast test suite so a live-coded change is verified in seconds.

Non-goals

- A UI. The brief says logic matters more than any screen.
- A real database, a real email/SMS provider, real Pub/Sub.
- Multi-instance deployment. The design leaves the seam but does not build it.
- Authentication for `POST /bookings` and `GET /:code`. The brief gives them as
  open endpoints; the README states the production answer.

Anti-goals (what would make this a failure even if it works)

- Enterprise scaffolding for problems the brief does not have. The job posting
  says this outright. Every extra must name the risk it addresses.
- Needing Docker or cloud access to run the core path.
- A reviewer unable to understand the flow in ten minutes from the README.
- A time log that is not truthful. The brief makes integrity mandatory.

## 3. Constraints

From the brief

- 5-character alphanumeric codes, unique across bookings.
- No database. In-memory or file, but every read and write is asynchronous.
- Confirmation is never in the `POST` response.
- Server keeps trying until the guest acknowledges. No giving up.
- The guest never receives the same confirmation twice.
- Nothing is sent to a real external service.

From Herman

- NestJS, following the StaySuitely `nest-server` production conventions
  (Node 22, pnpm, strict TypeScript, ESLint 9 flat config, Prettier,
  lefthook, commitlint, nestjs-pino, Joi-validated config, Swagger, terminus,
  shutdown hooks, multi-stage Dockerfile, GitHub Actions CI).
- Work is delivered as several pull requests on a fresh GitHub repository to
  simulate a real environment. Nothing is committed before the spec and plan
  exist and are approved.
- A clear `.env.example` documenting every required and optional variable.
- A FigJam diagram of the architecture and delivery sequence, produced with
  the Figma MCP at the end and linked from the README.
- The repository is public: `HermanL02/pentice-booking-confirmation-delivery`.
  Nothing is copied from StaySuitely. Lint and Prettier config are the generic
  Nest starter shape; the Pub/Sub consumer is written fresh.
- Time log policy: the core (PRs 1 to 3) is timed on its own and reported as
  the time-boxed deliverable. PRs 4 to 6 are timed separately and reported as
  extras built beyond the box. The README shows both numbers truthfully.
- No questions are sent to Pentice. Herman decides the open points himself
  and they are recorded as decisions (section 13), in the README, and on the
  FigJam diagram's decision panel.
- Google Pub/Sub is the broker because it is the stack Herman already runs in
  production. Redis is excluded. PR 5 is built, not conditional.

From the environment

- Local machine: Node 22.23, pnpm 11.21, gcloud SDK 573 with Java 25, no
  Docker. The Pub/Sub emulator runs locally through gcloud and in Docker on CI.
- GitHub account `HermanL02`.

## 4. Architecture

### 4.1 Overview

Two logical services in one Nest process, talking to each other only over HTTP:

- **Booking service**: owns bookings, codes, the outbox, the dispatcher, and
  the acknowledgement endpoint.
- **Guest device simulator**: a stand-in for the guest's phone. Receives
  confirmations on an inbox endpoint, dedupes them, and calls back to
  acknowledge. Can be switched offline or made to drop a percentage of
  deliveries.

They live in separate Nest modules with no shared providers, so moving the
simulator to its own process is a URL change.

### 4.2 The transactional outbox

The core correctness mechanism. Persisting the booking and enqueuing its
delivery are a single atomic write. There is no window in which a booking
exists without a pending delivery, or a delivery exists without its booking.

A background dispatcher drains the outbox:

1. Every tick (default 1 s), load outbox records that are `pending`, whose
   `nextAttemptAt` has passed, and whose `leaseUntil` is null or expired.
2. Claim each by writing `leaseUntil = now + leaseMs`, then send through the
   `DeliveryTransport` port.
3. On transport failure or timeout: `attempts += 1`, `nextAttemptAt` moved by
   the backoff policy, lease cleared, failure recorded in `history`.
4. On transport success: `attempts += 1`, `lastSentAt` set, `nextAttemptAt`
   moved by the backoff policy, lease cleared, `sent` recorded in `history`.
   The record stays `pending` until the guest acknowledges. Sending is not
   delivery: a confirmation the device received but lost is re-sent after the
   same backoff as a failed send.
5. Acknowledgement arrives on `POST /deliveries/:deliveryId/ack` with the
   `ackToken` that was in the payload. Record becomes `acked`.

Retries never stop. Backoff is exponential with full jitter, capped at
`DELIVERY_BACKOFF_MAX_MS` (default 5 minutes). Records that pass the
attention threshold are flagged and logged at error level; they keep retrying.

### 4.3 Exactly-once at the guest

The transport is at-least-once. Exactly-once is achieved by:

- One `deliveryId` per booking, fixed for the lifetime of the delivery. Every
  retry carries the same `deliveryId`.
- The guest device keeps the set of `deliveryId`s it has seen and discards
  repeats, but still acknowledges them (ack is idempotent).
- Once `acked`, the dispatcher never selects the record again.
- Race: an ack can arrive while a retry is in flight. The retry lands at the
  guest, which discards it by `deliveryId`. The late ack is a no-op.

### 4.4 Idempotency on the write side

- `POST /bookings` is idempotent on `reservationId`. The first call returns
  `202`. A repeat with the same `guest` returns the same `deliveryId` with
  `200`. A repeat with a different `guest` is rejected with `409`, because a
  silent contact change would send the confirmation to the wrong person.
  (Builder's call, settled by Claude.)
- `POST /deliveries/:deliveryId/ack` is idempotent. Unknown `deliveryId`
  returns `404`. Wrong token returns `401`. Already acked returns `200`.

### 4.5 Confirmation code

- Alphabet: lowercase `a-z` and `0-9`, 36^5 = 60,466,176 codes.
- Generated with `crypto.randomInt` per character.
- Uniqueness is enforced inside the store's write mutex: generate, check the
  code index, retry up to 5 times, then fail the request with `503`.
- Lookups normalise to lowercase, so `GET /A2B34` and `GET /a2b34` resolve the
  same booking. The README states this assumption.

### 4.6 Storage

`StoragePort` with one implementation, `FileStore`:

- A single JSON document (`DATA_FILE`, default `./data/store.json`).
- Every write: serialise the whole state, write to `store.json.tmp`, `fsync`,
  `rename` over the original. Readers never see a partial file.
- All mutations go through `async-mutex`. Each mutation is a function that
  receives the current state and returns the new state, so the booking and
  outbox writes in `POST /bookings` are one mutation.
- Reads return cloned data, never references into the cache.
- An optional `STORAGE_LATENCY_MS` adds artificial latency to every operation
  so tests and demos exercise the asynchronous nature the brief insists on.
- Whole-document snapshots are acceptable at this scale. The README's
  production path replaces this with a Postgres outbox table drained with
  `SELECT ... FOR UPDATE SKIP LOCKED`; the port does not change.

### 4.7 Transports

`DeliveryTransport` port:
`send(delivery): Promise<'sent' | 'handed-off'>`, rejecting on failure.

- `'sent'` means the transport itself confirmed the guest device accepted the
  message (2xx). The dispatcher records the outcome immediately.
- `'handed-off'` means the transport passed the message to an intermediary
  and the outcome will be reported later through `OutboxService.recordOutcome`.
  The dispatcher keeps the lease; if the lease expires with no outcome, that
  counts as a failed attempt.

The outbox is the only retry authority. There is exactly one retry loop.
(Builder's call, settled by Claude.)

- `WebhookTransport` (default): `POST` to `GUEST_DEVICE_INBOX_URL` with native
  `fetch` and an `AbortController` timeout (`DELIVERY_TIMEOUT_MS`). 2xx
  resolves `'sent'`; non-2xx or timeout rejects.
- `PubSubTransport` (optional, enabled when `PUBSUB_EMULATOR_HOST` is set):
  publishes the delivery to a topic and resolves `'handed-off'`. A consumer in
  the same process receives it, performs the webhook `POST`, and calls
  `recordOutcome(deliveryId, outcome)` on the outbox. The consumer always acks
  the Pub/Sub message after recording the outcome, including on failure, so
  Pub/Sub never redelivers on its own. Backoff, `attempts`, `history`,
  `needsAttention`, and `/metrics` therefore mean the same thing on both
  transports. The consumer drains in-flight handlers on shutdown. It is written
  fresh for this project, following the same ack-after-outcome and drain
  pattern as StaySuitely's consumer base, not copied from it.
- The outbox record is the source of truth: the emulator is in-memory and
  loses everything on restart, which is exactly why the outbox exists.

The transport is chosen once at boot by a factory provider. No runtime
fallback between transports.

### 4.8 Guest device simulator

Module `guest-device`:

- `POST /guest-device/inbox`: receives `{ deliveryId, confirmationCode,
  reservationId, ackToken, ackUrl }`. If offline, responds `503`. If the drop
  roll hits, responds `200` but does nothing (simulates a lost message). Else
  dedupes by `deliveryId`, records the confirmation, and calls `ackUrl` with
  the token. Ack is fire-and-forget with its own small retry so an ack lost in
  transit does not become a duplicate delivery.
- `PUT /guest-device/status`: `{ online: boolean, dropRate: 0..1 }`.
- `GET /guest-device/inbox`: the confirmations the device has received, for
  demos and tests.
- State is in-memory on purpose. The device is the unreliable side.

### 4.9 Events

`@nestjs/event-emitter` decouples the bookings module from delivery:
`bookings` emits `booking.created` after the atomic write; `delivery` listens
and starts the first dispatch attempt immediately instead of waiting for the
next tick. The outbox, not the event, is the durable record. If the listener
never runs, the tick picks the record up.

### 4.10 Ops and observability

- `GET /health`: terminus with two indicators, storage writable and dispatcher
  heartbeat within the last 3 ticks.
- `GET /metrics`: JSON counters and gauges: pending, acked, needsAttention,
  attempts histogram buckets, time-to-ack percentiles for acked records, ticks,
  transport failures. Enough to measure the SLO below. Prometheus text format
  is left to the builder as optional.
- `GET /deliveries?status=`, `GET /deliveries/:deliveryId`: inspection with the
  attempt history.
- `POST /deliveries/:deliveryId/retry-now`: clears `nextAttemptAt` so the next
  tick sends.
- Ops endpoints require `x-api-key: OPS_API_KEY`. Guard, not middleware, so the
  Swagger document shows it.
- Logging: `nestjs-pino`, one child logger per request with `correlationId`
  (from `x-correlation-id` or generated). Every dispatcher attempt logs
  `deliveryId`, `attempt`, outcome, and next attempt time.
- Alerting: at `DELIVERY_ATTENTION_AFTER_ATTEMPTS` (default 10) the record is
  flagged `needsAttention`, logged at error level, and reported to Sentry when
  `SENTRY_DSN` is set.
- Log shipping: when `BETTERSTACK_SOURCE_TOKEN` is set, pino adds a second
  transport target (`@logtail/pino`) that ships every structured log line to
  BetterStack Logs alongside stdout. Off by default.
- Uptime: BetterStack Uptime (or any HTTP monitor) probes `GET /health` every
  30 s in production. Nothing in the code depends on it; the README documents
  the monitor and the expected `200 { status: "ok" }` body.
- All three external sinks are env-gated and off by default. The core path
  never needs them.
- SLO stated in the README: 99 % of confirmations acknowledged within 60 s of
  booking while the device is online; measured by the time-to-ack percentile.

### 4.11 Security

- `helmet` on.
- `@nestjs/throttler` on `POST /bookings` only.
- Ack requires the per-delivery `ackToken` (32 random bytes, hex), issued at
  enqueue time and sent in the payload. Prevents a third party acking a
  delivery it never received.
- Ops endpoints behind `OPS_API_KEY`.
- Global `ValidationPipe` with `transform`, `whitelist`,
  `forbidNonWhitelisted` all on. The StaySuitely exception for partner payloads
  does not apply here.
- No secrets in the repo. `.env.example` is complete; `.env` is ignored.

### 4.12 Graceful shutdown

`enableShutdownHooks`. On SIGTERM the dispatcher stops claiming, waits for
in-flight sends up to `SHUTDOWN_DRAIN_MS` (default 10 s), the Pub/Sub consumer
drains the same way, then the store flushes. Leases left behind by a hard kill
expire on their own.

## 5. API

Required by the brief

| Method | Path | Body / params | Response |
|---|---|---|---|
| POST | `/bookings` | `{ reservationId: string, guest: string }` | `202 { reservationId, deliveryId, status: "pending" }`; repeat: `200`; conflict: `409` |
| GET | `/:code` | 5-char code, case-insensitive | `200 { reservationId, guest, confirmationCode, createdAt, delivery: { status, attempts, ackedAt } }`; `404` |

Delivery

| Method | Path | Notes |
|---|---|---|
| POST | `/deliveries/:deliveryId/ack` | `{ ackToken }` → `200`; `401`, `404` |
| GET | `/deliveries` | ops, `?status=pending|acked&attention=true` |
| GET | `/deliveries/:deliveryId` | ops, includes history |
| POST | `/deliveries/:deliveryId/retry-now` | ops |

Guest device simulator

| Method | Path |
|---|---|
| POST | `/guest-device/inbox` |
| PUT | `/guest-device/status` |
| GET | `/guest-device/inbox` |

Platform

| Method | Path |
|---|---|
| GET | `/health` |
| GET | `/metrics` |
| GET | `/api/docs` |

Route order: `GET /:code` is a catch-all. Its parameter is validated by a pipe
against `^[a-z0-9]{5}$` after lowercasing, and the bookings controller is
registered last so `/health`, `/metrics`, `/deliveries` are matched first.

## 6. Data model

```ts
interface Booking {
  reservationId: string;
  guest: string;            // contact as given; the channel decides how to use it
  confirmationCode: string; // lowercase, 5 chars
  deliveryId: string;       // uuid v4
  createdAt: string;        // ISO
}

interface OutboxRecord {
  deliveryId: string;
  confirmationCode: string;
  reservationId: string;
  guest: string;
  ackToken: string;
  status: 'pending' | 'acked';
  attempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  lastSentAt: string | null;
  ackedAt: string | null;
  needsAttention: boolean;
  createdAt: string;
  history: Array<{ at: string; attempt: number; outcome: 'sent' | 'failed' | 'timeout'; error?: string }>;
}

interface StoreState {
  version: 1;
  bookings: Record<string, Booking>;      // keyed by confirmationCode
  reservationIndex: Record<string, string>; // reservationId → confirmationCode
  outbox: Record<string, OutboxRecord>;   // keyed by deliveryId
}
```

`history` is capped at the last 50 entries per record so the file stays bounded.

## 7. Configuration

All variables validated by Joi at boot. The app refuses to start on a missing
required value or an invalid type.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | |
| `PORT` | no | `3000` | brief uses 3000 |
| `PUBLIC_BASE_URL` | no | `http://localhost:3000` | used to build `ackUrl` |
| `DATA_FILE` | no | `./data/store.json` | |
| `STORAGE_LATENCY_MS` | no | `0` | simulated async latency |
| `OPS_API_KEY` | yes | | ops endpoints |
| `GUEST_DEVICE_INBOX_URL` | no | `http://localhost:3000/guest-device/inbox` | |
| `DELIVERY_TICK_MS` | no | `1000` | |
| `DELIVERY_TIMEOUT_MS` | no | `3000` | |
| `DELIVERY_LEASE_MS` | no | `15000` | |
| `DELIVERY_BACKOFF_BASE_MS` | no | `1000` | |
| `DELIVERY_BACKOFF_MAX_MS` | no | `300000` | |
| `DELIVERY_ATTENTION_AFTER_ATTEMPTS` | no | `10` | |
| `SHUTDOWN_DRAIN_MS` | no | `10000` | |
| `LOG_LEVEL` | no | `info` | |
| `SENTRY_DSN` | no | | off when unset |
| `BETTERSTACK_SOURCE_TOKEN` | no | | ships pino logs to BetterStack when set |
| `BETTERSTACK_INGEST_HOST` | no | `https://in.logs.betterstack.com` | BetterStack ingest endpoint |
| `PUBSUB_EMULATOR_HOST` | no | | enables PubSubTransport |
| `GCP_PROJECT_ID` | when Pub/Sub | `booking-local` | |
| `PUBSUB_TOPIC` | when Pub/Sub | `confirmation-deliveries` | |
| `PUBSUB_SUBSCRIPTION` | when Pub/Sub | `confirmation-deliveries-sub` | |

`.env.example` lists every row with a comment. `OPS_API_KEY` is the only
required value, so the example ships with a clearly-marked placeholder.

## 8. Testing

Unit (Jest, ts-jest, no network, no file system except a temp dir)

- Code generator: length, alphabet, distribution sanity.
- `FileStore`: atomic write leaves no partial file when the process is killed
  between tmp write and rename (simulated by injecting a failing rename);
  concurrent mutations serialise; reads are isolated copies.
- Backoff policy: exponential growth, jitter within bounds, cap honoured;
  fake timers.
- Dispatcher: claims only due and unleased records; failure schedules the next
  attempt; ack stops selection; attention flag at threshold.
- Ack controller: token validation, idempotency, 404.

End-to-end (supertest against a real Nest app on a temp data file)

- Happy path: `POST`, device acks, `GET /:code` resolves, outbox `acked`.
- Offline then online: device offline, `POST`, attempts grow with backoff,
  device online, ack arrives, record `acked`, inbox has exactly one entry.
- Drop rate 1.0 then 0: same assertion, exercises the "sent but lost" case.
- Restart: `POST` with device offline, close the app, boot a new app on the
  same file, device online, delivery completes.
- Concurrency: 50 parallel `POST`s, 50 distinct codes, 50 outbox records.
- Idempotency: repeated `POST` same `reservationId`; repeated ack.
- Route safety: `GET /health` and `GET /deliveries` are not swallowed by
  `GET /:code`; `GET /abcdef` (6 chars) is `400`.

Pub/Sub path (integration, only when `PUBSUB_EMULATOR_HOST` is set, run in CI)

- Happy path and offline-then-online through `PubSubTransport`.

The whole unit suite must run in under 10 seconds so it is usable during the
live-coding round.

## 9. Tooling and delivery process

- Repository: `HermanL02/pentice-booking-confirmation-delivery` on GitHub,
  default branch `main`, branch protection requiring CI green.
- Package manager pinned with `packageManager` in `package.json`.
- Lint and format: copied from StaySuitely `nest-server` (`eslint.config.mjs`,
  `.prettierrc`), minus the Stripe-specific rule.
- `lefthook` pre-commit: lint, type-check. `commitlint` conventional commits.
- CI (GitHub Actions, `ubuntu-latest`): lint, type-check, build, unit + e2e
  tests with coverage; a second job starts the Pub/Sub emulator in Docker and
  runs the integration tests.
- Dockerfile: multi-stage, `node:22-alpine` builder, `node:22-slim` runtime,
  non-root user, `curl` healthcheck on `/health`. No Playwright.
- `docker-compose.yml`: the Pub/Sub emulator only, for machines that have
  Docker. `pnpm emulator` runs it through gcloud for machines that do not.
- Scripts: `pnpm demo` runs the offline-then-online scenario against a running
  server and prints the outbox state at each step.

Pull requests, in order. Each is a feature branch, CI green, merged with a
merge commit. Each description states what it adds, how it was verified, and
which decisions it makes.

1. `chore: scaffold` — Nest app, tooling, config + Joi, pino, Swagger,
   terminus, helmet, CI, lefthook, commitlint, `.env.example`, README skeleton.
2. `feat: storage and bookings` — `StoragePort`, `FileStore`, code generator,
   `POST /bookings`, `GET /:code`, unit + e2e.
3. `feat: outbox delivery` — outbox, dispatcher, backoff, lease,
   `WebhookTransport`, ack endpoint, guest device simulator, events, e2e
   scenarios including restart.
4. `feat: operations` — ops endpoints, API key guard, metrics, attention
   threshold, Sentry sink, graceful drain, demo script.
5. `feat: pubsub transport` — `PubSubTransport`, consumer, emulator setup
   script, compose file, CI integration job.
6. `docs: readme, decisions, diagram` — full README, decision records, time
   log, AI-usage section, Figma/FigJam diagram link, Dockerfile.

Nothing is committed until this document and the plan are approved.

## 10. README contents

- What this is and how to run it in one command.
- Sequence of a booking from `POST` to ack, and what happens when the device
  is offline.
- Assumptions, each in one line.
- Decision records: outbox over queue; no automatic dead-letter; file
  snapshots over append log; simulator in-process; Redis excluded; Pub/Sub as
  optional transport; `forbidNonWhitelisted` on.
- Production path: Postgres outbox, multi-instance leases, real channel
  providers, secrets.
- SLO and how `/metrics` measures it.
- How AI was used, what was reviewed, what was rejected.
- Time log, actual hours.
- The open points from the brief and the decision Herman made on each
  (section 13), with the FigJam diagram's decision panel mirroring them.

## 11. Seams for the live-coding round

Each is a change the reviewer might ask for, and where it lands:

| Requirement shift | Change |
|---|---|
| Add SMS as a second channel | New `DeliveryTransport` implementation; choose per guest contact type in the factory |
| Codes expire after N hours | `expiresAt` on `Booking`; `GET /:code` checks it; dispatcher stops at expiry |
| Cancel a booking | `DELETE /bookings/:reservationId`; outbox record → `cancelled`; dispatcher skips |
| Hard cap on retries with dead-letter | `DELIVERY_MAX_ATTEMPTS`; status `dead`; ops endpoint to replay |
| Change code length or alphabet | Constants in `code-generator.ts`; validation pipe regex derives from them |
| Guest changes contact mid-delivery | `PATCH /bookings/:reservationId/guest`; outbox record updated under the mutex |
| Multiple instances | Lease already exists; swap `FileStore` for a shared store |

## 12. Left to the builder

- Exact module and file names within the structure above.
- Whether `/metrics` also offers Prometheus text format.
- Backoff jitter formula, as long as it is full jitter with the stated cap.
- How the demo script prints its output.
- Dockerfile details beyond the stated stages and user.

## 13. Decisions Herman made on open points

The brief leaves these open. Herman decided them without asking Pentice; the
brief says assumptions are the candidate's to define. Each appears in the
README's decision list and on the FigJam diagram's decision panel.

1. **Broker.** Google Pub/Sub is used as an optional transport because it is
   the stack Herman already operates in production. Redis is not used. The
   file-backed outbox remains the source of truth on every transport.
2. **Code case.** Codes are not case-sensitive. Stored lowercase, lookups
   lowercase the input. Micro-decision, logged on the diagram.
3. **Unknown code.** `GET /:code` for an unknown code returns `404` with a
   small JSON error body (`{ statusCode, message }`, Nest's default), not an
   empty body.
4. **POST response.** `POST /bookings` returns `202 Accepted` with
   `{ reservationId, deliveryId, status }` and no confirmation code.
