# Booking Confirmation Delivery

A NestJS 11 service for the Pentice code challenge. When a guest books, it
generates a unique 5-character confirmation code, persists it without a
database, and delivers it to the guest's device out-of-band. It keeps retrying
until the device acknowledges, never delivers the same confirmation twice, and
resolves `GET /:code` back to the booking. Delivery runs through a
transactional outbox stored in a JSON file. A simulated guest device in the
same process stands in for the guest's phone. The full design is in
[`docs/superpowers/specs/`](docs/superpowers/specs/2026-10-17-booking-confirmation-delivery-design.md)
and the task plan in
[`docs/superpowers/plans/`](docs/superpowers/plans/2026-10-17-booking-confirmation-delivery.md).

## Run it

Needs Node 22 and pnpm 11 (`corepack enable`). No Docker, database or cloud
account is needed.

```bash
cp .env.example .env        # then set OPS_API_KEY in .env to any secret
pnpm install
pnpm start:dev              # http://localhost:3000
```

- Swagger UI: <http://localhost:3000/api/docs>. Ops routes need the
  `x-api-key` header, which you set with the "Authorize" button.
- `OPS_API_KEY` is the only required variable. The app will not start without
  it. If you change `PORT`, also change `PUBLIC_BASE_URL` and
  `GUEST_DEVICE_INBOX_URL`, because the device and the ack link use them.

**Demo.** With the server running, in a second terminal:

```bash
OPS_API_KEY=<the value in .env> pnpm demo      # BASE_URL defaults to http://localhost:3000
```

The demo takes the device offline, books, shows the failed attempts and the
backoff, brings the device back online and waits for the ack. Output from a
real run:

```text
1. Guest device set offline: the inbox now answers 503.
2. POST /bookings R-demo-c1cf1b6c -> 202, deliveryId=724de8f9-6d0a-485a-8960-3e3d81913aa4
3. GET /deliveries/724de8f9-...: status=pending attempts=2 nextAttemptAt=2026-10-17T19:46:57.700Z last=failed (guest device responded 503)
4. GET /deliveries/724de8f9-...: status=pending attempts=3 nextAttemptAt=2026-10-17T19:47:01.075Z last=failed (guest device responded 503)
5. GET /deliveries/724de8f9-...: status=pending attempts=3 nextAttemptAt=2026-10-17T19:47:01.075Z last=failed (guest device responded 503)
6. Guest device set online.
7. Delivery acked at 2026-10-17T19:47:01.122Z after 4 attempt(s).
8. GET /e6kuk -> {"reservationId":"R-demo-c1cf1b6c","guest":"guest@example.com","confirmationCode":"e6kuk","createdAt":"2026-10-17T19:46:56.282Z","delivery":{"status":"acked","attempts":4,"ackedAt":"2026-10-17T19:47:01.122Z"}}
```

**Docker.** The image is multi-stage: it builds on `node:22-alpine` and runs
on `node:22-slim` as the non-root user `nodejs`, with a `HEALTHCHECK` on
`/health`. Docker is not installed on the author's machine, so CI builds the
image on every push.

```bash
docker build -t booking-confirmation-delivery .
docker run --rm -e OPS_API_KEY=change-me -p 3000:3000 \
  -v bcd-data:/app/data booking-confirmation-delivery
```

The volume is optional. It keeps `/app/data/store.json`, which holds the
outbox, across container restarts.

## How a booking flows

1. `POST /bookings { reservationId, guest }` is validated. One storage
   mutation then writes the booking, the reservation index entry and an
   outbox record (`pending`, `attempts: 0`, a fresh `deliveryId` and a
   32-byte `ackToken`). The file is replaced atomically. The response is
   `202 { reservationId, deliveryId, status: "pending" }`. It does not
   contain the code. A repeat with the same guest returns `200` with the same
   `deliveryId` and the delivery's current `status` (`pending` or `acked`).
2. After the write, `booking.created` is emitted. The dispatcher claims the
   record right away by setting a lease (`leaseUntil = now + 15 s`). It then
   sends `{ deliveryId, confirmationCode, reservationId, guest, ackToken,
   ackUrl }` to the device inbox over HTTP.
3. The device records the confirmation (deduped by `deliveryId`), answers
   200, and posts the token to
   `ackUrl` (`POST /deliveries/:deliveryId/ack`). The record becomes `acked`
   and is never selected again.
4. Meanwhile the dispatcher records the send: `attempts += 1`, `sent` in
   `history`, `lastSentAt` set, lease cleared, and `nextAttemptAt` moved by
   the backoff. The ack and this outcome can land in either order. If the ack
   won, the send is still counted (`attempts`, `history`, `lastSentAt`), but
   the record stays `acked` and nothing is rescheduled: ack never reopens a
   delivery. A send is not a delivery. If no ack arrives (the device took the
   message and lost it), the record is sent again when that time comes.

**Device offline.** The inbox answers 503. That attempt is recorded as
`failed`, and the next one is scheduled with exponential backoff and full
jitter (base 1 s, cap 5 min). A 1 s tick drains whatever is due, so retries
never stop. After 10 attempts the record is flagged `needsAttention` and an
error-level alert is raised. It keeps retrying. When the device comes back,
the next due attempt is acked, and the inbox still holds exactly one entry.
`retry-now` skips the wait. A tick with nothing due changes nothing, and the
store skips writing a state identical to the last one written, so an idle
service does not rewrite or `fsync` the file.

**Restart.** All delivery state is in `store.json`, so a new process picks
up every pending record on its first tick. A record that was mid-send when
the process died still holds a lease. Once the lease expires it is charged
one `lease-expired` attempt and retried. On a graceful shutdown (SIGTERM),
the dispatcher stops claiming and waits up to `SHUTDOWN_DRAIN_MS` for
in-flight sends. Records it claimed but never sent are released without an
attempt.

## API

| Method | Path | Auth | Responses |
|---|---|---|---|
| POST | `/bookings` | none, rate limited per IP | `202` created; `200` repeat with same guest (same `deliveryId`, current `status`: `pending` or `acked`); `400` invalid or unknown fields, or a `reservationId` of `__proto__`, `constructor` or `prototype`; `409` same `reservationId`, different guest; `429` throttled; `503` no unique code after 5 tries |
| GET | `/:code` | none | `200 { reservationId, guest, confirmationCode, createdAt, delivery: { status, attempts, ackedAt } }`; `400` not 5 alphanumerics; `404 { statusCode, message, error }` |
| POST | `/deliveries/:deliveryId/ack` | `ackToken` in body | `200 { status: "acked" \| "already-acked" }`; `400` malformed token; `401` wrong token; `404` unknown delivery |
| GET | `/deliveries?status=pending\|acked&attention=true\|false` | `x-api-key` | `200` records oldest first, `ackToken` omitted; `400`; `401` |
| GET | `/deliveries/:deliveryId` | `x-api-key` | `200` record with `history`; `401`; `404` |
| POST | `/deliveries/:deliveryId/retry-now` | `x-api-key` | `200 { scheduled: true }`, due now; with a send in flight it takes effect after that attempt lands (no second concurrent send); `401`; `404` unknown or already acked |
| GET | `/metrics` | `x-api-key` | `200` snapshot (see Operations); `401` |
| GET | `/health` | none | `200 { status: "ok", ... }`; `503` when an indicator is down |
| GET | `/api/docs` | none | Swagger UI |
| GET | `/` | none | `200 { service }` |
| POST | `/guest-device/inbox` | none (simulator) | `200 { result: "received" \| "duplicate" \| "dropped" }`; `400`; `503` offline |
| PUT | `/guest-device/status` | none (simulator) | `{ online, dropRate }` → `200`; `400` |
| GET | `/guest-device/inbox` | none (simulator) | `200 { items }`, what the device has received |
| DELETE | `/guest-device/inbox` | none (simulator) | `204`, clears the inbox and dedupe set |

`GET /:code` is a catch-all, so the bookings controller is registered last.
Its parameter is lowercased and then checked against `^[a-z0-9]{5}$`. The
e2e suite checks that `/health` is not swallowed by it.

## Guarantees and how they are met

| Guarantee | How | Where |
|---|---|---|
| A booking never exists without its delivery, or the reverse | Booking, index and outbox record are written in one `FileStore.mutate`, under one mutex. The file is written to `store.json.tmp`, `fsync`ed and renamed, so the file on disk is always a complete state | `bookings.service.ts`, `file-store.ts` |
| Retries never stop | No attempt cap. Backoff `random() * min(max, base * 2^(n-1))`. The attention flag only alerts | `outbox.service.ts`, `backoff.policy.ts` |
| The guest sees each confirmation once | One `deliveryId` per booking, reused on every retry. The device drops repeats and still acks them. Ack is idempotent. An acked record is never claimed again. A send outcome that lands after the ack is counted but never reopens the record | `guest-device.service.ts`, `outbox.service.ts` |
| Only the guest can ack | 32-byte random `ackToken` per delivery, compared in constant time and hidden from ops responses | `outbox.record.ts`, `ops.controller.ts` |
| Crash safety | All state is in the file, and a restart resumes from it. Leases from a dead process expire. Tested by booking with the device offline, closing the app, booting a new one on the same file and seeing one delivery | `restart.e2e-spec.ts` |
| Lease semantics | A record is claimed only when `pending`, due, and unleased. An expired lease counts as an attempt (`lease-expired`), because the send may have landed. A lease released on shutdown does not count, because nothing was sent. A record expired in a pass is not reclaimed in the same pass | `outbox.service.ts`, `dispatcher.service.ts` |

Known limits, stated plainly:

- The device's dedupe set lives in memory, because the simulator is the
  unreliable side. Suppose a confirmation reached the device, every ack try
  was lost, and then the process restarted. The device would then record the
  re-send as new. A real device must persist the `deliveryId`s it has seen.
- After 5 code collisions in a row, `POST /bookings` fails with 503
  (`could not allocate a unique confirmation code`) and writes nothing. At
  60 million codes this does not happen in practice.
- The data directory is not `fsync`ed after the rename. After a power loss
  the file holds either the previous complete state or the new one, never a
  partial one.

## Operations

- **Inspect and act.** `GET /deliveries` (filter by `status` and
  `attention`), `GET /deliveries/:id` with the last 50 attempts, and
  `POST /deliveries/:id/retry-now`. All of them need `x-api-key: $OPS_API_KEY`.
  `retry-now` makes the record due now. If a send is in flight (its lease is
  live), the lease is kept so no second send starts concurrently, and the
  retry takes effect after that in-flight attempt lands: that attempt is the
  retry, and its outcome schedules the next one as usual.
  The check is a guard, not middleware, so Swagger shows it.
- **`/metrics`** (JSON, needs `x-api-key`):

  | Field | Meaning |
  |---|---|
  | `pending`, `acked` | outbox records by status |
  | `needsAttention` | pending records past the attention threshold |
  | `attemptsHistogram` | records by attempts made: `1`, `2-3`, `4-10`, `11+` |
  | `timeToAckMs.p50/p95/p99` | nearest-rank percentiles of `ackedAt - createdAt` over acked records |
  | `ticks`, `lastTickAt` | dispatcher activity since this process started |
  | `transportFailures` | failed or timed-out sends since this process started |

- **SLO.** 99 % of confirmations acknowledged within 60 s of booking while
  the device is online, measured by `/metrics` `timeToAckMs.p99`. The
  percentile covers every acked record, including ones delayed while the
  device was offline, so it errs on the strict side.
- **Alerts.** At `DELIVERY_ATTENTION_AFTER_ATTEMPTS` (10) the record is
  flagged and an error is logged: `delivery needs attention deliveryId=…
  attempts=…`. When `SENTRY_DSN` is set (in the environment or in `.env`,
  which `instrument.ts` loads before it initialises the SDK), the alert also
  goes to Sentry, and so do unhandled exceptions. The flag is written before
  the alert fires.
- **Logs.** `nestjs-pino` JSON logs on stdout. Each request log line carries
  the correlation id as `req.id` and `correlationId`. pino-http's `genReqId`
  sets it (from `x-correlation-id`, else a new UUID) before any Nest
  middleware runs, and echoes it in the `x-correlation-id` response header.
  Each send logs `deliveryId`, `attempt`, `outcome` and `nextAttemptAt`.
  When `BETTERSTACK_SOURCE_TOKEN` is set, a second pino target
  (`@logtail/pino`) also ships every line to BetterStack Logs.
- **Health.** `GET /health` checks two things: the store is readable and its
  directory is writable, and the dispatcher ticked within the last 3 tick
  intervals. In production, BetterStack Uptime (or any HTTP monitor) probes it
  every 30 s and expects `200` with `"status": "ok"`. The Docker
  `HEALTHCHECK` uses the same endpoint. No code depends on the monitor.
- Sentry, BetterStack Logs and the Uptime monitor are all off unless
  configured. The core path never needs them.

## Configuration

Every variable is validated by Joi at boot. The app refuses to start on a
missing required value or a bad type. [`.env.example`](.env.example) lists
them all.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | base of the `ackUrl` sent to the device |
| `DATA_FILE` | `./data/store.json` | the JSON store file |
| `STORAGE_LATENCY_MS` | `0` | artificial latency on every storage call |
| `OPS_API_KEY` | required | key for the ops routes and `/metrics` |
| `GUEST_DEVICE_INBOX_URL` | `http://localhost:3000/guest-device/inbox` | where deliveries are posted |
| `DELIVERY_TICK_MS` | `1000` | dispatcher tick interval |
| `DELIVERY_TIMEOUT_MS` | `3000` | per-send HTTP timeout |
| `DELIVERY_LEASE_MS` | `15000` | lease before a claimed record can be reclaimed |
| `DELIVERY_BACKOFF_BASE_MS` | `1000` | backoff base |
| `DELIVERY_BACKOFF_MAX_MS` | `300000` | backoff cap |
| `DELIVERY_ATTENTION_AFTER_ATTEMPTS` | `10` | attempts before `needsAttention` and the alert |
| `SHUTDOWN_DRAIN_MS` | `10000` | how long shutdown waits for in-flight sends |
| `LOG_LEVEL` | `info` | pino level |
| `THROTTLE_LIMIT_PER_MINUTE` | `100` | rate limit on `POST /bookings` per client IP |
| `SENTRY_DSN` | blank (off) | Sentry error and alert reporting |
| `BETTERSTACK_SOURCE_TOKEN` | blank (off) | ships logs to BetterStack |
| `BETTERSTACK_INGEST_HOST` | `https://in.logs.betterstack.com` | BetterStack ingest endpoint |
| `PUBSUB_EMULATOR_HOST` | blank (off) | e.g. `localhost:8085`; enables the Pub/Sub transport |
| `GCP_PROJECT_ID` | `booking-local` | Pub/Sub project |
| `PUBSUB_TOPIC` | `confirmation-deliveries` | Pub/Sub topic |
| `PUBSUB_SUBSCRIPTION` | `confirmation-deliveries-sub` | Pub/Sub subscription |

## Testing

```bash
pnpm test           # unit, about 5 s
pnpm test:e2e       # e2e against a real Nest app on a temp data file
pnpm test:cov       # unit with coverage
```

- **Unit** (Jest, no network). Covers the code generator, the atomic
  `FileStore` (failed rename, serialised mutations, isolated reads), the
  backoff bounds, skipped writes for unchanged state, outbox transitions
  (including outcomes after ack, `retry-now` with a live lease and
  prototype-named ids), the 503 on code collisions, the dispatcher, the
  webhook transport, the correlation id, the ack and ops controllers,
  metrics, alerts, the guard, the config schema and the health indicators. The suite stays well under 10 s, so it can be
  rerun after every change while live coding.
- **E2E**, by scenario:
  - bookings: `POST` returns 202 without a code; `GET /:code` resolves
    case-insensitively; unknown code 404; `/health` not swallowed by
    `/:code`; extra field 400; empty guest 400; repeat same guest 200 with the
    same `deliveryId`; repeat different guest 409; 50 parallel POSTs give 50
    distinct codes; 2 parallel identical POSTs give one 202 and one 200;
    `reservationId` `constructor`, `__proto__` or `prototype` is 400;
    `GET /deliveries/__proto__` (and other prototype names) is 404.
  - delivery: happy path acked once with exactly one `sent` attempt;
    offline then online, retried with backoff until acked, exactly one inbox
    entry; drop rate 1 then 0
    (sent but lost is retried); wrong ack token 401; ack twice 200 then
    `already-acked`; unknown delivery 404; a late ack after a retry is in
    flight does not duplicate; connection refused is a failed attempt.
  - restart: a pending delivery is delivered once by the next process on
    the same data file and port.
  - ops: no key 401; the list shows the pending record; `retry-now` sends on
    the next tick; `/metrics` needs the key and returns a snapshot.
  - logging: the request log line carries the `x-correlation-id` sent, or
    the generated one that is echoed.
  - harness: two apps booted in one file both see the Joi defaults; invalid
    env rejects without leaving a temp dir.
- **Pub/Sub integration** (`test/pubsub.integration-spec.ts`). Runs the happy
  path and offline-then-online through `PubSubTransport`. Without
  `PUBSUB_EMULATOR_HOST` it skips itself, so `pnpm test:e2e` passes on any
  machine.
- **CI** (GitHub Actions). The `check` job runs lint, type-check, build,
  `docker build`, unit with coverage, and e2e. The `pubsub-integration` job
  starts the emulator in Docker and runs the integration spec. Lefthook runs
  lint and type-check before each commit, and commitlint checks commit
  messages.

## Pub/Sub transport

`PubSubTransport` is an optional second implementation of
`DeliveryTransport`. It publishes the delivery to a topic and returns
`'handed-off'`. A consumer in the same process receives the message, makes the
same webhook call to the device, and reports the outcome to the outbox. It is
optional because the brief allows no real external service and the core path
must run with one command. It exists because Pub/Sub is the broker Herman runs
in production, and it shows the outbox working behind one. Set
`PUBSUB_EMULATOR_HOST` to turn it on. Leave it unset for the webhook
transport. The choice is made once at boot.

**Why the consumer always acks.** The outbox is the only retry authority.
The consumer records the outcome and then acks the Pub/Sub message, success
or failure, so Pub/Sub never redelivers on its own. Backoff, `attempts`,
`history`, `needsAttention` and `/metrics` therefore mean the same on both
transports. A message lost inside Pub/Sub shows up as an expired lease and is
retried by the outbox. The emulator keeps nothing across restarts, which is
fine because the outbox holds the state.

Run it locally without Docker (gcloud SDK with the Pub/Sub emulator component
and Java):

```bash
pnpm emulator                                          # terminal 1: gcloud emulator on localhost:8085
PUBSUB_EMULATOR_HOST=localhost:8085 GCP_PROJECT_ID=booking-local pnpm emulator:setup   # topic + subscription, idempotent
PUBSUB_EMULATOR_HOST=localhost:8085 GCP_PROJECT_ID=booking-local pnpm start:dev
PUBSUB_EMULATOR_HOST=localhost:8085 pnpm test:e2e -- pubsub                           # integration spec
```

With Docker, `docker compose up -d` starts the same emulator on port 8085 from
`docker-compose.yml`. The remaining steps are the same.

## Design diagrams

The FigJam board is at <https://www.figma.com/board/iKhJVAQBaxSCflAZK5GhoZ>.
It holds three things:

- Architecture v2: Bookings, Outbox and Dispatcher, the transport port with
  Webhook and Pub/Sub, the Guest Device, FileStore, and Ops/Metrics/Health.
- The delivery sequence from `POST /bookings` to ack, with the offline,
  backoff and retry branch.
- The decision panel, which mirrors the list below.

## Decisions

Full records, each with context, decision, consequences and how to reverse
it, are in [`docs/decisions.md`](docs/decisions.md).

| # | Decision |
|---|---|
| 1 | A transactional outbox in the store instead of a queue: the booking and its delivery are one atomic write |
| 2 | Retries never stop and there is no automatic dead-letter. After 10 attempts the record is flagged and an alert raised |
| 3 | The store is a whole-file JSON snapshot (tmp, fsync, rename), not an append log |
| 4 | The guest device simulator runs in the same process, in its own module, reached only over HTTP |
| 5 | No Redis. Google Pub/Sub is an optional transport, enabled by env |
| 6 | The outbox owns backoff on every transport, and the Pub/Sub consumer always acks |
| 7 | `forbidNonWhitelisted` is on: unknown fields are a 400 |
| 8 | Codes are case-insensitive: stored lowercase, lookups lowercased |
| 9 | An unknown code returns 404 with Nest's JSON error body |
| 10 | `POST /bookings` returns 202 with `deliveryId` and no code |
| 11 | A repeat `POST` with the same guest returns 200 with the same delivery; a different guest returns 409 |
| 12 | An expired lease counts as an attempt; a lease released on shutdown does not |
| 13 | No OpenTelemetry. Sentry and BetterStack are env-gated and off by default |
| 14 | A send outcome that lands after the ack is counted; ack never reopens a delivery |

Assumptions, each a call the brief left open:

- `guest` is an opaque contact string. The channel decides how to use it.
- A code is 5 characters from `a-z0-9`, made with `crypto.randomInt`, and
  unique across all bookings.
- `reservationId` identifies a booking. A second booking for the same
  reservation is a repeat, not a new booking.
- `POST /bookings` and `GET /:code` are open, as in the brief. Production
  would put them behind the booking flow's own authentication.
- One instance. The lease model already allows more (see Production path).
- Ids are keys of plain-object maps in the store. Every keyed read checks own
  properties, so a `reservationId`, `deliveryId` or code such as
  `constructor` or `toString` is simply unknown (404), never an inherited
  member. Writes are guarded at the edge: `POST /bookings` rejects a
  `reservationId` of `__proto__`, `constructor` or `prototype` with `400`,
  because `__proto__` cannot be stored as an own key. `deliveryId`s are
  server-generated UUIDs and are only ever read from the path, so a
  prototype name there is a `404`, not a `400`.

## Production path

- **Store.** A Postgres `outbox` table written in the same transaction as
  the booking. The dispatcher claims due rows with
  `SELECT ... FOR UPDATE SKIP LOCKED` and sets `lease_until`. `StoragePort`
  and `OutboxService` keep their shape.
- **Multiple instances.** Leases are already in the model: a record is
  claimable only when unleased, and an expired lease is charged and reclaimed.
  With a shared store, N dispatchers can run side by side. The in-memory
  metrics counters would move to the store or to Prometheus.
- **Real channels.** Email or SMS providers go behind `DeliveryTransport`,
  chosen per guest contact type. A provider's delivery receipt or the app's
  open event takes the place of the device ack.
- **Secrets.** `OPS_API_KEY`, `SENTRY_DSN` and the BetterStack token come from
  a secret manager, not `.env`. The ops key becomes per-operator credentials.
- **No simulator.** `GuestDeviceModule` would not be imported in
  production, and `GUEST_DEVICE_INBOX_URL` would point at a real provider or
  disappear with the webhook-to-simulator path.

## Likely requirement changes and where they land

| Requirement shift | Change |
|---|---|
| Add SMS as a second channel | New `DeliveryTransport` implementation; choose per guest contact type in the factory |
| Codes expire after N hours | `expiresAt` on `Booking`; `GET /:code` checks it; dispatcher stops at expiry |
| Cancel a booking | `DELETE /bookings/:reservationId`; outbox record → `cancelled`; dispatcher skips |
| Hard cap on retries with dead-letter | `DELIVERY_MAX_ATTEMPTS`; status `dead`; ops endpoint to replay |
| Change code length or alphabet | Constants in `code-generator.ts`; validation pipe regex derives from them |
| Guest changes contact mid-delivery | `PATCH /bookings/:reservationId/guest`; outbox record updated under the mutex |
| Multiple instances | Lease already exists; swap `FileStore` for a shared store |

## What I would do with one more hour

- **Prune acked records.** The outbox keeps every acked record forever, and
  every write serialises the whole file, so write cost grows with history. A
  retention window (say 7 days after `ackedAt`) would bound it.
- **Measure write amplification.** Before the final fix, every idle
  dispatcher tick rewrote and `fsync`ed the whole store, once per second.
  Unchanged states are now skipped, but each claim and outcome still rewrites
  everything. I would count bytes written per minute in `/metrics` and use it
  to decide when to move to an append log or Postgres.
- **Close the prototype-key class of bug for good.** The review found that
  ids like `constructor` crashed `POST /bookings` and the ops routes with a
  500. Reads are now own-property checked and the DTO rejects unsafe ids, but
  the root cause is plain objects used as maps. I would load the store into
  null-prototype objects or `Map`s and add a property-based test over
  arbitrary id strings.
- **Prometheus text format.** `/metrics` is a JSON snapshot. Serving the
  same counters in the Prometheus exposition format would let a standard
  scraper and alert rules use them directly.
- **`trust proxy` for the throttler.** Behind a load balancer every client
  shares the balancer's IP, so the per-IP limit on `POST /bookings` becomes
  global. Setting Express `trust proxy` to the balancer hop count fixes the
  key.

## How AI was used

Claude Code wrote the code, working from a written spec and plan in
[`docs/superpowers/`](docs/superpowers/). For each task it dispatched one
implementer subagent, then one independent reviewer subagent that read the
diff against the spec. Every task was test-first: the failing test was
written and run before the code. Herman, the owner, reviewed and approved the
spec and plan before anything was committed, made the open-point decisions
(broker, code case, unknown-code response, `POST` response), and kept the
time-box.

Three things the reviews caught that were changed:

- **File store cache aliasing.** `mutate` handed back objects that were
  still referenced by the in-memory cache, so a caller could change stored
  state without a write. The fix rebuilds the cache from the serialised bytes
  on every write (`8726012`).
- **Dispatcher drain gap.** The shutdown drain waited only for sends already
  in progress. Records claimed but not yet sent kept their leases and would
  have been charged an attempt after restart. The drain now tracks whole ticks
  and releases unsent leases without an attempt (`e496337`).
- **Ack-vs-sent race.** On a fast machine the device's ack could land before
  the dispatcher recorded `sent`, and the late outcome was dropped, so an
  acked record could show `attempts: 0`. The test was first made to tolerate
  both orders (`8ed20cd`). The final review settled it in the code instead:
  an outcome after the ack is counted but never reopens the record
  (decision 14), and the test asserts exactly one attempt again.

Other review fixes are in the history as `fix(...)` commits, for example
claimDue no longer reclaims a record it has just expired.

## Time log

The full record is in [`docs/time-log.md`](docs/time-log.md). The core
(PRs 1 to 3) is the time-boxed deliverable. PRs 4 to 6 are extras built
beyond the box.

| Date | Phase | Start | End | Hours | Notes |
|---|---|---|---|---|---|
| 2026-10-17 | Design and planning (spec, plan, JD review, FigJam architecture diagram) | — | 15:24 | not measured by the agent; Herman records the actual span | Before the first commit |
| 2026-10-17 | Core: PR 1 scaffold, config, bootstrap, health, CI | 15:24 | 15:37 | 0.2 | 4 tasks, 2 review rounds |
| 2026-10-17 | Core: PR 2 storage, codes, bookings API, e2e harness | 15:37 | 15:59 | 0.4 | 4 tasks, 2 fix rounds |
| 2026-10-17 | Core: PR 3 outbox, dispatcher, transport, ack, guest device, e2e scenarios | 15:59 | 16:28 | 0.5 | 5 tasks, 5 fix rounds |
| 2026-10-17 | Extras: PR 4 ops API, metrics, alerts, demo | 16:28 | 16:46 | 0.3 | 4 tasks batched |
| 2026-10-17 | Extras: PR 5 Pub/Sub transport | 16:40 | 17:02 | 0.4 | Built in parallel with PR 6 |
| 2026-10-17 | Extras: PR 6 Dockerfile, README, decisions, diagram, whole-project review and final fix wave | 16:44 | 17:30 | 0.8 | 2 tasks batched, FigJam diagram by the main agent; review findings fixed in one pass |

Core subtotal (build only): 1.1 h, plus design and planning above. Extras subtotal: 1.5 h (sum of the rows; PRs 5 and 6 overlapped, so the wall-clock span 16:28 to 17:30 is 1.0 h).

## Repository layout

```text
src/
  main.ts, app.module.ts, instrument.ts   bootstrap, global pipes, Swagger, Sentry init
  config/          Joi env schema and typed config namespaces
  storage/         StoragePort and the atomic FileStore
  bookings/        POST /bookings, GET /:code, code generator and pipe
  delivery/        outbox, dispatcher, backoff, ack, ops, metrics
    transport/     DeliveryTransport port, webhook and Pub/Sub transports, consumer
  guest-device/    the simulated guest device
  health/          terminus indicators (storage, dispatcher)
  common/          clock, correlation id, ops key guard, alerts, log transport
test/              e2e scenarios, Pub/Sub integration spec, helpers
scripts/           demo, Pub/Sub emulator start and setup
docs/              decisions, time log, spec and plan
Dockerfile, docker-compose.yml, .env.example, .github/workflows/ci.yml
```
