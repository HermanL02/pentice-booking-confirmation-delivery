# Booking Confirmation Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A NestJS service that generates unique 5-character booking confirmation codes, persists them to a crash-safe file, delivers them to a simulated guest device through a transactional outbox with endless retries, and resolves `GET /:code`.

**Architecture:** One Nest process with two HTTP-only modules: the booking service (bookings, file store, outbox, dispatcher, ack, ops) and a guest-device simulator. The outbox record written atomically with the booking is the single retry authority; transports (`WebhookTransport`, optional `PubSubTransport`) sit behind one port and report outcomes back to the outbox.

**Tech Stack:** Node 22, pnpm, TypeScript strict, NestJS 11 on Express, class-validator, @nestjs/config + Joi, @nestjs/schedule, @nestjs/event-emitter, nestjs-pino, @nestjs/swagger, @nestjs/terminus, @nestjs/throttler, helmet, async-mutex, @google-cloud/pubsub, @sentry/nestjs, Jest + ts-jest + supertest, ESLint 9 + Prettier, lefthook + commitlint, GitHub Actions, Docker.

**Spec:** `docs/superpowers/specs/2026-10-17-booking-confirmation-delivery-design.md`

## Global Constraints

- Node `>=22`, pnpm pinned via `packageManager` in `package.json`.
- NestJS major 11 for every `@nestjs/*` package. Express adapter.
- TypeScript strict: `strict: true`, `noImplicitAny`, `strictNullChecks`, target ES2023, CommonJS, path alias `@/* → src/*`.
- Global `ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })`.
- Confirmation code: exactly 5 chars from `abcdefghijklmnopqrstuvwxyz0123456789`, stored lowercase, lookups lowercase the input.
- No database. One JSON file at `DATA_FILE` (default `./data/store.json`), written tmp + fsync + rename, every mutation under one mutex.
- `POST /bookings` → `202 { reservationId, deliveryId, status: "pending" }`; repeat same guest → `200`; repeat different guest → `409`.
- `GET /:code` → `200` booking JSON; unknown → `404` with Nest default error body; wrong shape → `400`.
- Confirmation code never appears in a `POST /bookings` response.
- Retries never stop. Backoff: full jitter, `delay = random(0, min(max, base * 2^(attempts-1)))`, base `DELIVERY_BACKOFF_BASE_MS` (default 1000), cap `DELIVERY_BACKOFF_MAX_MS` (default 300000).
- Every send attempt (success or failure) increments `attempts` and advances `nextAttemptAt` by backoff.
- One `deliveryId` per booking for its whole life. Ack requires the 64-hex-char `ackToken`. Ack is idempotent.
- Ops endpoints require header `x-api-key` equal to `OPS_API_KEY` (the only required env var).
- Nothing copied from StaySuitely. Public repo `HermanL02/pentice-booking-confirmation-delivery`.
- Conventional commits. Each PR: feature branch, CI green, merged with `--merge`.
- Unit suite completes in under 10 seconds. No network or real file system in unit tests except a temp directory.
- Core time (PRs 1 to 3) and extras time (PRs 4 to 6) are logged separately in the README.

## Review Focus

1. `GET /:code` with mixed case (`A2b34`) must resolve the lowercase booking; a 4- or 6-char value or one with `-` must be `400`, never `404` and never caught by another route. Test added in Task 9.
2. A corrupt or truncated `store.json` at boot must fail startup with a clear error, never be silently replaced by an empty store. A missing file is initialised. Test added in Task 6.
3. `GUEST_DEVICE_INBOX_URL` refusing connections (nothing listening) must be a failed attempt with backoff, not an unhandled rejection or a crashed tick. Tests added in Task 12 (transport unit) and Task 15 (e2e).
4. Two parallel `POST /bookings` with the same `reservationId` must yield one `202` and one `200` with the same `deliveryId`, never two bookings. Test added in Task 9.
5. An ack that arrives while the record is leased (handed-off or mid-send) must mark it `acked`, and a later `recordOutcome` for that delivery must not reopen it. Tests added in Task 11 (unit) and Task 15 (late-ack e2e).

---

## PR 0: Repository and docs on `main`

### Task 0: Initialise the repository with the spec and plan

**Files:**
- Create: `.gitignore`, `README.md` (two-line placeholder)
- Existing: `docs/superpowers/specs/2026-10-17-booking-confirmation-delivery-design.md`, `docs/superpowers/plans/2026-10-17-booking-confirmation-delivery.md`

- [ ] **Step 1: Create `.gitignore`** with `node_modules/`, `dist/`, `coverage/`, `data/*.json`, `data/*.tmp`, `.env`, `.env.local`, `*.log`.
- [ ] **Step 2: `git init -b main`** in `booking-confirmation-delivery/`, commit the two docs, `.gitignore`, and the placeholder README: `docs: add design spec and implementation plan`.
- [ ] **Step 3: Create the public repo and push**

```bash
gh repo create HermanL02/pentice-booking-confirmation-delivery --public --source=. --remote=origin --push --description "Pentice code challenge: booking confirmation delivery (NestJS, transactional outbox)"
```

Expected: `https://github.com/HermanL02/pentice-booking-confirmation-delivery` exists with one commit on `main`.

---

## PR 1: `chore: scaffold` — app skeleton, tooling, config, logging, health, CI

Branch: `chore/scaffold`. Time: core.

### Task 1: Nest application skeleton and tooling

**Files:**
- Create: `package.json`, `.npmrc` (`engine-strict=true`), `.nvmrc` (`22`), `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `eslint.config.mjs`, `.prettierrc`, `lefthook.yml`, `commitlint.config.js`, `src/main.ts`, `src/app.module.ts`, `src/app.controller.ts`, `src/app.controller.spec.ts`, `test/jest-e2e.json`

**Interfaces:**
- Produces: `pnpm` scripts `build`, `start`, `start:dev`, `start:prod`, `lint`, `lint:check`, `format`, `type-check`, `test`, `test:cov`, `test:e2e`. Jest unit config in `package.json` with `rootDir: src`, `testRegex: .*\.spec\.ts$`, `moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" }`. E2E config `test/jest-e2e.json` with `testRegex: .(e2e-spec|integration-spec).ts$`, `rootDir: .`, mapper to `<rootDir>/../src/$1`.

- [ ] **Step 1: Scaffold** with `pnpm dlx @nestjs/cli@11 new . --package-manager pnpm --skip-git --strict` (or write the files by hand to the same shape). Set `"packageManager": "pnpm@<installed version>"`, `"engines": { "node": ">=22" }`, `"private": true`, `"name": "booking-confirmation-delivery"`.
- [ ] **Step 2: tsconfig** — `strict: true`, `target: ES2023`, `module: commonjs`, `emitDecoratorMetadata`, `experimentalDecorators`, `baseUrl: ./`, `paths: { "@/*": ["src/*"] }`, `outDir: ./dist`, `sourceMap: true`, `skipLibCheck: true`. `tsconfig.build.json` excludes `test`, `scripts`, `**/*.spec.ts`. Add `tsc-alias` to the `build` script: `nest build && tsc-alias`.
- [ ] **Step 3: ESLint flat config** — `@eslint/js` recommended, `typescript-eslint` `recommendedTypeChecked`, `eslint-plugin-prettier/recommended`, globals node + jest, `parserOptions.project: ./tsconfig.json`, rules `@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/no-floating-promises: error`. Relax `no-unsafe-*` in `**/*.spec.ts`, `**/*-spec.ts`, `test/**`. `.prettierrc`: `{ "singleQuote": true, "trailingComma": "all" }`.
- [ ] **Step 4: lefthook + commitlint** — `lefthook.yml` pre-commit: `pnpm lint --fix` and `pnpm type-check` on `*.ts`, `stage_fixed: true`; commit-msg: `pnpm dlx commitlint --edit {1}`. `commitlint.config.js`: `module.exports = { extends: ['@commitlint/config-conventional'] }`. Add `lefthook`, `@commitlint/cli`, `@commitlint/config-conventional` as dev deps; `"prepare": "lefthook install"`.
- [ ] **Step 5: Smoke test** — `src/app.controller.spec.ts`: `AppController.getRoot()` returns `{ service: 'booking-confirmation-delivery' }`.
- [ ] **Step 6: Verify** — `pnpm lint:check && pnpm type-check && pnpm build && pnpm test`. Expected: all pass, 1 test.
- [ ] **Step 7: Commit** `chore: scaffold nest application with lint, format, hooks`.

### Task 2: Validated configuration

**Files:**
- Create: `src/config/env.schema.ts`, `src/config/app.config.ts`, `src/config/delivery.config.ts`, `src/config/pubsub.config.ts`, `src/config/env.schema.spec.ts`, `.env.example`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces:
  - `envSchema: Joi.ObjectSchema` covering every variable in spec section 7 with the spec's defaults.
  - `appConfig = registerAs('app', () => ({ env, port, publicBaseUrl, dataFile, storageLatencyMs, opsApiKey, logLevel, sentryDsn, betterstackSourceToken, betterstackIngestHost }))` — types: `AppConfig`.
  - `deliveryConfig = registerAs('delivery', () => ({ tickMs, timeoutMs, leaseMs, backoffBaseMs, backoffMaxMs, attentionAfterAttempts, shutdownDrainMs, guestDeviceInboxUrl }))` — `DeliveryConfig`.
  - `pubsubConfig = registerAs('pubsub', () => ({ enabled: boolean, emulatorHost, projectId, topic, subscription }))` — `PubSubConfig`, `enabled = !!PUBSUB_EMULATOR_HOST`.
  - Consumers inject with `@Inject(appConfig.KEY) cfg: ConfigType<typeof appConfig>`.

- [ ] **Step 1: Write failing tests** in `env.schema.spec.ts`:
  - `rejects when OPS_API_KEY is missing` — `envSchema.validate({})` has `error` mentioning `OPS_API_KEY`.
  - `applies defaults` — validating `{ OPS_API_KEY: 'k' }` yields `PORT: 3000`, `DELIVERY_TICK_MS: 1000`, `DELIVERY_BACKOFF_MAX_MS: 300000`, `DATA_FILE: './data/store.json'`.
  - `rejects a non-numeric DELIVERY_TICK_MS`.
  - `rejects PUBLIC_BASE_URL that is not a URI`.
- [ ] **Step 2: Run** `pnpm test -- env.schema` — FAIL (module not found).
- [ ] **Step 3: Implement** `envSchema` and the three `registerAs` factories. Register `ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema, validationOptions: { abortEarly: false }, load: [appConfig, deliveryConfig, pubsubConfig] })` in `AppModule`.
- [ ] **Step 4: Write `.env.example`** — every variable from spec section 7, one comment line each, `OPS_API_KEY=change-me` marked `# REQUIRED`.
- [ ] **Step 5: Run** `pnpm test -- env.schema` — PASS.
- [ ] **Step 6: Commit** `feat(config): joi-validated environment with typed namespaces`.

### Task 3: Bootstrap: logging, validation, Swagger, helmet, throttler, shutdown hooks, correlation id

**Files:**
- Create: `src/common/correlation-id.middleware.ts`, `src/common/correlation-id.middleware.spec.ts`, `src/common/common.module.ts`, `src/common/logger.transport.ts`, `src/common/logger.transport.spec.ts`
- Modify: `src/main.ts`, `src/app.module.ts`

**Interfaces:**
- Produces: `CorrelationIdMiddleware` sets `req.id` and response header `x-correlation-id` from the incoming header or `randomUUID()`. `LoggerModule.forRootAsync` builds `pinoHttp: { genReqId: (req) => req.id, level: LOG_LEVEL, transport }` where `transport` is `undefined` when `BETTERSTACK_SOURCE_TOKEN` is unset, and otherwise `{ targets: [{ target: 'pino/file', options: { destination: 1 } }, { target: '@logtail/pino', options: { sourceToken, options: { endpoint: betterstackIngestHost } } }] }`. Add `@logtail/pino` as a dependency. Unit test `logger.transport.spec.ts`: `buildPinoTransport(cfg)` returns `undefined` without a token and two targets with one. `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }])` registered, guard not global. `main.ts` exports `createApp(): Promise<INestApplication>` used by e2e helpers, and `bootstrap()` which calls it and listens on `PORT`, host `0.0.0.0`.

- [ ] **Step 1: Write failing test** `correlation-id.middleware.spec.ts`: `reuses incoming x-correlation-id` and `generates a uuid when absent` (assert header set on `res`, `req.id` equals it).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the middleware; apply it to all routes from `AppModule.configure(consumer)`. In `AppModule` also register `LoggerModule.forRoot(...)`, `ScheduleModule.forRoot()`, `EventEmitterModule.forRoot()`, and `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }])`.
- [ ] **Step 4: Implement `createApp()`** in `main.ts`: `NestFactory.create(AppModule, { bufferLogs: true })`, `app.useLogger(app.get(Logger))` (nestjs-pino), `app.use(helmet())`, `app.enableShutdownHooks()`, global `ValidationPipe` per Global Constraints, Swagger `DocumentBuilder` title `Booking Confirmation Delivery`, `addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'ops')`, served at `api/docs`.
- [ ] **Step 5: Verify manually** — `OPS_API_KEY=k pnpm start:dev`, `curl -i localhost:3000/` shows `x-correlation-id`, `curl localhost:3000/api/docs` is HTML. Stop the server.
- [ ] **Step 6: Run** `pnpm test` — PASS.
- [ ] **Step 7: Commit** `feat(bootstrap): pino logging, validation, swagger, helmet, shutdown hooks`.

### Task 4: Health endpoint and CI workflow

**Files:**
- Create: `src/health/health.module.ts`, `src/health/health.controller.ts`, `src/health/health.controller.spec.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `GET /health` via `@nestjs/terminus` `HealthCheckService.check([])` (indicators added in Tasks 7 and 11). CI job `check` on `ubuntu-latest`: pnpm install frozen, `lint:check`, `type-check`, `build`, `test:cov`, `test:e2e` with `OPS_API_KEY=ci`. Concurrency group per PR.

- [ ] **Step 1: Write failing test** `health.controller.spec.ts`: `returns status ok` using `Test.createTestingModule` with `TerminusModule`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `HealthController` with `@Get('health') @HealthCheck()`.
- [ ] **Step 4: Write `ci.yml`** — triggers `pull_request` to `main` and `push` to `main`; `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` with node 22 and pnpm cache; steps in the order above; upload `coverage/` as artifact.
- [ ] **Step 5: Run** `pnpm test` — PASS. `pnpm test:e2e` — PASS with zero suites (no e2e files yet) or a placeholder.
- [ ] **Step 6: Commit** `feat(health): terminus health endpoint; ci: lint, typecheck, build, test`.

### Task 5: Open PR 1, CI green, merge, branch protection

- [ ] **Step 1:** `git push -u origin chore/scaffold`; `gh pr create --base main --title "chore: scaffold NestJS service, tooling, config, health, CI" --body-file <description>`. The body lists what the PR adds, the verification commands and their output, and the decisions (forbidNonWhitelisted on, pnpm, Nest 11).
- [ ] **Step 2:** Wait for `gh pr checks --watch`. Fix and push if red.
- [ ] **Step 3:** `gh pr merge --merge --delete-branch`.
- [ ] **Step 4: Branch protection** — `gh api -X PUT repos/HermanL02/pentice-booking-confirmation-delivery/branches/main/protection` with `required_status_checks: { strict: true, contexts: ["check"] }`, `enforce_admins: false`, `required_pull_request_reviews: null`, `restrictions: null`. Verify with `gh api .../branches/main/protection | jq .required_status_checks`.

---

## PR 2: `feat: storage and bookings`

Branch: `feat/storage-and-bookings`. Time: core.

### Task 6: Storage port and atomic file store

**Files:**
- Create: `src/storage/storage.port.ts`, `src/storage/file-store.ts`, `src/storage/file-store.spec.ts`, `src/storage/storage.module.ts`, `src/common/clock.ts`

**Interfaces:**
- Produces:
  ```ts
  // storage.port.ts
  export interface Booking { reservationId: string; guest: string; confirmationCode: string; deliveryId: string; createdAt: string }
  export type OutboxOutcome = 'sent' | 'failed' | 'timeout' | 'lease-expired';
  export interface OutboxHistoryEntry { at: string; attempt: number; outcome: OutboxOutcome; error?: string }
  export interface OutboxRecord { deliveryId; confirmationCode; reservationId; guest; ackToken; status: 'pending' | 'acked'; attempts: number; nextAttemptAt: string; leaseUntil: string | null; lastSentAt: string | null; ackedAt: string | null; needsAttention: boolean; createdAt: string; history: OutboxHistoryEntry[] }
  export interface StoreState { version: 1; bookings: Record<string, Booking>; reservationIndex: Record<string, string>; outbox: Record<string, OutboxRecord> }
  export const emptyState = (): StoreState => ({ version: 1, bookings: {}, reservationIndex: {}, outbox: {} });
  export interface StoragePort {
    read(): Promise<StoreState>;                                   // deep clone
    mutate<T>(fn: (draft: StoreState) => T | Promise<T>): Promise<T>; // serialised; draft persisted atomically after fn
  }
  export const STORAGE = Symbol('STORAGE');
  // clock.ts
  export interface Clock { now(): Date }
  export const CLOCK = Symbol('CLOCK');
  export class SystemClock implements Clock { now() { return new Date(); } }
  // file-store.ts
  export interface FileStoreOptions { filePath: string; latencyMs?: number; fs?: Pick<typeof import('node:fs/promises'), 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'open'> }
  export class FileStore implements StoragePort, OnModuleInit { constructor(opts: FileStoreOptions); onModuleInit(): Promise<void> /* load or init */ }
  ```
  `StorageModule` is `@Global()`, provides `STORAGE` (FileStore from `appConfig.dataFile`, `storageLatencyMs`) and `CLOCK`.

- [ ] **Step 1: Write failing tests** in `file-store.spec.ts` (temp dir via `fs.mkdtemp`):
  - `initialises an empty state when the file is missing` — after `onModuleInit`, `read()` equals `emptyState()` and the file exists.
  - `fails to start on a corrupt file` — write `{"version":1,"book` then `onModuleInit` rejects with message containing `store.json` and `corrupt`.
  - `persists a mutation atomically` — mutate adds a booking; a fresh `FileStore` on the same path reads it; no `*.tmp` file remains.
  - `leaves the original intact when rename fails` — inject `fs` whose `rename` rejects; mutate rejects; `read()` on a fresh store equals the previous state.
  - `serialises concurrent mutations` — 20 parallel `mutate(d => { d.reservationIndex[String(Object.keys(d.reservationIndex).length)] = 'x' })`; final index has 20 keys.
  - `read returns a copy` — mutate the returned object; `read()` again is unchanged.
  - `applies latencyMs` — `latencyMs: 20`, `read()` takes ≥ 20 ms (fake timers acceptable).
- [ ] **Step 2: Run** `pnpm test -- file-store` — FAIL.
- [ ] **Step 3: Implement `FileStore`** — `async-mutex` `Mutex.runExclusive` around mutate; write `${filePath}.tmp` with `JSON.stringify(state, null, 2)`, `open` + `fsync` + `close`, then `rename`. Deep clone with `structuredClone`. `mkdir -p` the parent on init.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(storage): atomic file store behind StoragePort`.

### Task 7: Storage health indicator

**Files:**
- Create: `src/health/storage.health.ts`, `src/health/storage.health.spec.ts`
- Modify: `src/health/health.controller.ts`, `src/health/health.module.ts`

**Interfaces:**
- Produces: `StorageHealthIndicator.isHealthy(key = 'storage')` → up when `read()` resolves and the data directory is writable (`fs.access(dir, W_OK)`), down otherwise.

- [ ] **Step 1: Write failing tests**: `reports up when store reads and dir is writable`; `reports down when read rejects`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** and add to the `/health` check list. **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(health): storage indicator`.

### Task 8: Confirmation code generator and code pipe

**Files:**
- Create: `src/bookings/code-generator.ts`, `src/bookings/code-generator.spec.ts`, `src/bookings/confirmation-code.pipe.ts`, `src/bookings/confirmation-code.pipe.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  export const CODE_LENGTH = 5;
  export const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
  export function generateCode(random: (max: number) => number = crypto.randomInt): string;
  export function generateUniqueCode(taken: (code: string) => boolean, maxTries = 5): string; // throws CodeCollisionError
  export class CodeCollisionError extends Error {}
  export class ConfirmationCodePipe implements PipeTransform<string, string> // lowercases, validates CODE_PATTERN, throws BadRequestException
  ```

- [ ] **Step 1: Write failing tests**: `produces 5 chars from the alphabet` (1000 samples); `uses the injected random` (stub returning 0 → `aaaaa`); `retries on collision then succeeds` (taken returns true 4 times); `throws CodeCollisionError after maxTries`; pipe: `lowercases A2B34 to a2b34`; `rejects 4 chars`, `rejects 6 chars`, `rejects a2b-4` with `BadRequestException`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(bookings): confirmation code generator and validation pipe`.

### Task 9: Bookings service, controller, DTO, e2e

**Files:**
- Create: `src/bookings/bookings.module.ts`, `src/bookings/bookings.service.ts`, `src/bookings/bookings.service.spec.ts`, `src/bookings/bookings.controller.ts`, `src/bookings/dto/create-booking.dto.ts`, `src/bookings/events/booking-created.event.ts`, `test/helpers/create-test-app.ts`, `test/bookings.e2e-spec.ts`
- Modify: `src/app.module.ts` (register `BookingsModule` last)

**Interfaces:**
- Consumes: `STORAGE`, `CLOCK`, `generateUniqueCode`, `ConfirmationCodePipe`.
- Produces:
  ```ts
  export class CreateBookingDto { @IsString() @IsNotEmpty() @MaxLength(64) reservationId: string; @IsString() @IsNotEmpty() @MaxLength(256) guest: string }
  export interface CreateBookingResult { created: boolean; reservationId: string; deliveryId: string; status: 'pending' }
  export class BookingsService {
    create(dto: CreateBookingDto): Promise<CreateBookingResult>; // throws ConflictException on different guest
    findByCode(code: string): Promise<BookingView>;              // throws NotFoundException
  }
  export interface BookingView { reservationId; guest; confirmationCode; createdAt; delivery: { status; attempts; ackedAt: string | null } }
  export class BookingCreatedEvent { constructor(readonly deliveryId: string) {} }  // name 'booking.created'
  // test helper
  export async function createTestApp(env?: Record<string, string>): Promise<{ app: INestApplication; baseUrl: string; dataFile: string; close(): Promise<void> }>
  ```
  In PR 2 `create` writes only the booking and reservation index (deliveryId = `randomUUID()`); PR 3 adds the outbox record to the same mutation. `findByCode` returns `delivery: { status: 'pending', attempts: 0, ackedAt: null }` until PR 3 wires the outbox.

- [ ] **Step 1: Write failing unit tests** `bookings.service.spec.ts` with an in-memory `StoragePort` stub:
  - `creates a booking with a unique lowercase code and returns created=true`.
  - `returns the same deliveryId with created=false for a repeat with the same guest`.
  - `throws ConflictException for a repeat with a different guest`.
  - `findByCode lowercases and returns the view`; `findByCode throws NotFoundException`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** service and controller. Controller: `@Post('bookings')` returns `202` when `created`, else `200` (use `@Res({ passthrough: true })` to set status). `@Get(':code')` with `ConfirmationCodePipe`. Emit `booking.created` after the mutation resolves. Apply `@UseGuards(ThrottlerGuard)` on the POST only. **Step 4: Run** — PASS.
- [ ] **Step 5: Write `createTestApp`** — picks a free port, sets `OPS_API_KEY=test`, `DATA_FILE=<tmp>/store.json`, `PORT`, `PUBLIC_BASE_URL=http://127.0.0.1:<port>`, `GUEST_DEVICE_INBOX_URL=http://127.0.0.1:<port>/guest-device/inbox`, `DELIVERY_TICK_MS=50`, `DELIVERY_BACKOFF_BASE_MS=20`, `DELIVERY_BACKOFF_MAX_MS=200`, `DELIVERY_LEASE_MS=500`, `DELIVERY_TIMEOUT_MS=500`, `LOG_LEVEL=silent`, merged with `env`; calls `createApp()` then `app.listen(port)`.
- [ ] **Step 6: Write failing e2e** `bookings.e2e-spec.ts`:
  - `POST /bookings returns 202 without a confirmation code in the body` (assert `body.confirmationCode` undefined, `status: 'pending'`, `deliveryId` uuid).
  - `GET /:code resolves the booking case-insensitively` (read code from the data file, request upper-cased).
  - `GET /:code returns 404 for unknown`, `400 for abcd`, `400 for abcdef`, `400 for ab-cd`.
  - `GET /health is not swallowed by GET /:code`.
  - `POST with an extra field returns 400`; `POST with empty guest returns 400`.
  - `repeat POST same guest returns 200 with the same deliveryId`; `repeat POST different guest returns 409`.
  - `50 parallel POSTs produce 50 distinct codes`.
  - `2 parallel POSTs with the same reservationId yield one 202 and one 200 with equal deliveryId`.
- [ ] **Step 7: Run** `pnpm test:e2e -- bookings` — PASS. **Step 8: Run** `pnpm test` — total under 10 s.
- [ ] **Step 9: Commit** `feat(bookings): POST /bookings and GET /:code with idempotency`.

### Task 10: Open PR 2, CI green, merge

Same steps as Task 5 (title `feat: storage and bookings`). Record core time so far in `docs/time-log.md` (created here, one line per session: date, start, end, hours, PR).

---

## PR 3: `feat: outbox delivery`

Branch: `feat/outbox-delivery`. Time: core.

### Task 11: Outbox record, backoff policy, outbox service

**Files:**
- Create: `src/delivery/outbox.record.ts`, `src/delivery/backoff.policy.ts`, `src/delivery/backoff.policy.spec.ts`, `src/delivery/outbox.service.ts`, `src/delivery/outbox.service.spec.ts`, `src/delivery/delivery.module.ts`
- Modify: `src/bookings/bookings.service.ts` (add the outbox record to the create mutation; `findByCode` reads delivery status from the outbox), `src/bookings/bookings.service.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function newOutboxRecord(input: { deliveryId; confirmationCode; reservationId; guest }, now: Date, ackToken = randomBytes(32).toString('hex')): OutboxRecord; // attempts 0, nextAttemptAt now, pending
  export class BackoffPolicy { constructor(baseMs: number, maxMs: number, random: () => number = Math.random); delayMs(attempts: number): number } // attempts ≥ 1
  export class OutboxService {
    claimDue(now: Date, leaseMs: number): Promise<OutboxRecord[]>;     // expires stale leases as 'lease-expired' failures first, then claims due unleased pending records
    claimOne(deliveryId: string, now: Date, leaseMs: number): Promise<OutboxRecord | null>;
    recordOutcome(deliveryId: string, outcome: OutboxOutcome, now: Date, error?: string): Promise<OutboxRecord | null>; // attempts+1, nextAttemptAt += backoff, lease null, history push (cap 50), needsAttention at threshold; no-op if acked or missing
    ack(deliveryId: string, ackToken: string, now: Date): Promise<'acked' | 'already-acked' | 'invalid-token' | 'not-found'>;
    retryNow(deliveryId: string, now: Date): Promise<boolean>;
    list(filter: { status?: 'pending' | 'acked'; attention?: boolean }): Promise<OutboxRecord[]>;
    get(deliveryId: string): Promise<OutboxRecord | null>;
  }
  ```
  `DeliveryModule` provides `BackoffPolicy` from `deliveryConfig` and `OutboxService`; exports `OutboxService`.

- [ ] **Step 1: Write failing tests** `backoff.policy.spec.ts`: `attempt 1 is within [0, base]`; `attempt 4 is within [0, base*8]`; `is capped at maxMs` (attempts 30); `uses injected random` (random → 1 gives exactly `min(max, base*2^(n-1))`).
- [ ] **Step 2: Write failing tests** `outbox.service.spec.ts` with the in-memory `StoragePort` stub and a fixed clock:
  - `claimDue returns due unleased pending records and sets leaseUntil`.
  - `claimDue skips records with a live lease`; `claimDue skips acked records`; `claimDue skips records whose nextAttemptAt is in the future`.
  - `claimDue expires a stale lease as a lease-expired failure before claiming` (history has `lease-expired`, attempts 1).
  - `recordOutcome sent increments attempts, sets lastSentAt, clears lease, schedules next attempt`.
  - `recordOutcome failed schedules next attempt by backoff` (random → 1, assert exact delay).
  - `recordOutcome flags needsAttention at the threshold` (threshold 3).
  - `recordOutcome caps history at 50`.
  - `ack with the right token marks acked and clears lease`; `ack again returns already-acked`; `ack with wrong token returns invalid-token`; `ack unknown returns not-found`.
  - `recordOutcome after ack is a no-op` (Review Focus 5).
  - `retryNow sets nextAttemptAt to now`.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** — PASS.
- [ ] **Step 6: Modify `BookingsService.create`** to call `newOutboxRecord` inside the same `mutate`, and `findByCode` to read `status`, `attempts`, `ackedAt` from `draft.outbox[booking.deliveryId]`. Update its unit test: `creates the outbox record in the same mutation` (stub's mutate called once, state has both). Run `pnpm test -- bookings.service` — PASS.
- [ ] **Step 7: Commit** `feat(delivery): outbox service with lease, backoff and idempotent ack`.

### Task 12: Transport port, webhook transport, ack endpoint

**Files:**
- Create: `src/delivery/transport/delivery-transport.port.ts`, `src/delivery/transport/webhook.transport.ts`, `src/delivery/transport/webhook.transport.spec.ts`, `src/delivery/transport/transport.provider.ts`, `src/delivery/ack.controller.ts`, `src/delivery/ack.controller.spec.ts`, `src/delivery/dto/ack.dto.ts`
- Modify: `src/delivery/delivery.module.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DeliveryPayload { deliveryId; confirmationCode; reservationId; guest; ackToken; ackUrl } // ackUrl = `${publicBaseUrl}/deliveries/${deliveryId}/ack`
  export type SendResult = 'sent' | 'handed-off';
  export interface DeliveryTransport { send(payload: DeliveryPayload): Promise<SendResult> }
  export const DELIVERY_TRANSPORT = Symbol('DELIVERY_TRANSPORT');
  export class TransportError extends Error { constructor(message: string, readonly kind: 'failed' | 'timeout') }
  export class WebhookTransport implements DeliveryTransport { constructor(inboxUrl: string, timeoutMs: number, fetchFn = globalThis.fetch) }
  export function toPayload(record: OutboxRecord, publicBaseUrl: string): DeliveryPayload;
  export class AckDto { @IsString() @Length(64, 64) ackToken: string }
  // POST /deliveries/:deliveryId/ack → 200 { status: 'acked' | 'already-acked' }, 401 invalid-token, 404 not-found
  ```
  `transport.provider.ts` exports a factory provider for `DELIVERY_TRANSPORT` that returns `WebhookTransport` (PR 5 adds the Pub/Sub branch).

- [ ] **Step 1: Write failing tests** `webhook.transport.spec.ts` with a stub `fetchFn`: `resolves sent on 200`; `rejects TransportError failed on 503`; `rejects TransportError timeout when fetch aborts` (fetchFn rejects with `AbortError`); `rejects TransportError failed on connection refused` (fetchFn rejects with `TypeError: fetch failed`) — Review Focus 3; `posts the payload as JSON to the inbox url`.
- [ ] **Step 2: Write failing tests** `ack.controller.spec.ts`: maps the four `OutboxService.ack` results to 200/200/401/404.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** using `AbortSignal.timeout(timeoutMs)`. **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `feat(delivery): webhook transport and acknowledgement endpoint`.

### Task 13: Dispatcher and booking.created listener

**Files:**
- Create: `src/delivery/dispatcher.service.ts`, `src/delivery/dispatcher.service.spec.ts`, `src/health/dispatcher.health.ts`, `src/health/dispatcher.health.spec.ts`
- Modify: `src/delivery/delivery.module.ts`, `src/health/health.module.ts`, `src/health/health.controller.ts`

**Interfaces:**
- Consumes: `OutboxService`, `DELIVERY_TRANSPORT`, `CLOCK`, `deliveryConfig`, `appConfig.publicBaseUrl`, `SchedulerRegistry`.
- Produces:
  ```ts
  export class DispatcherService implements OnApplicationBootstrap, OnModuleDestroy {
    readonly lastTickAt: Date | null;
    tick(): Promise<void>;                         // no-overlap guard; claimDue → send each (concurrently, max 10) → recordOutcome; errors never escape
    dispatchOne(deliveryId: string): Promise<void>; // claimOne → send → recordOutcome
    @OnEvent('booking.created') onBookingCreated(e: BookingCreatedEvent): Promise<void>; // calls dispatchOne
    onApplicationBootstrap(): void;                 // registers interval 'dispatcher' with tickMs
    onModuleDestroy(): Promise<void>;               // stop interval, await in-flight up to shutdownDrainMs
  }
  export class DispatcherHealthIndicator { isHealthy(key = 'dispatcher') } // up when lastTickAt within 3 * tickMs
  ```
  For `'sent'`: `recordOutcome(id, 'sent')`. For `TransportError`: `recordOutcome(id, err.kind, now, err.message)`. For `'handed-off'`: leave the lease; outcome arrives via `recordOutcome` from the consumer (PR 5).

- [ ] **Step 1: Write failing tests** `dispatcher.service.spec.ts` with stubbed `OutboxService` and transport:
  - `tick sends every claimed record and records sent`.
  - `tick records failed with the transport error kind and message`.
  - `tick does not overlap` (second `tick()` while first pending resolves without calling claimDue again).
  - `tick survives a throwing transport` (rejects with a plain Error → recorded as `failed`, tick resolves).
  - `handed-off leaves the record leased and records nothing`.
  - `onBookingCreated dispatches that delivery immediately`.
  - `onModuleDestroy waits for in-flight sends up to the drain limit` (fake timers).
  - `dispatcher.health.spec.ts`: up within 3 ticks, down otherwise.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(delivery): dispatcher with lease, immediate dispatch and drain`.

### Task 14: Guest device simulator

**Files:**
- Create: `src/guest-device/guest-device.module.ts`, `src/guest-device/guest-device.service.ts`, `src/guest-device/guest-device.service.spec.ts`, `src/guest-device/guest-device.controller.ts`, `src/guest-device/dto/inbox-message.dto.ts`, `src/guest-device/dto/device-status.dto.ts`
- Modify: `src/app.module.ts` (register before `BookingsModule`)

**Interfaces:**
- Produces:
  ```ts
  export class InboxMessageDto { deliveryId: string; confirmationCode: string; reservationId: string; guest: string; ackToken: string; ackUrl: string } // all @IsString() @IsNotEmpty(); ackUrl @IsUrl({ require_tld: false })
  export class DeviceStatusDto { @IsBoolean() online: boolean; @IsNumber() @Min(0) @Max(1) dropRate: number }
  export class GuestDeviceService {
    constructor(fetchFn = globalThis.fetch, random = Math.random)
    status(): { online: boolean; dropRate: number };
    setStatus(s: DeviceStatusDto): void;
    receive(msg: InboxMessageDto): 'offline' | 'dropped' | 'duplicate' | 'received';  // dedupe by deliveryId
    inbox(): Array<{ deliveryId; confirmationCode; reservationId; receivedAt }>;
    reset(): void;
    acknowledge(ackUrl: string, ackToken: string): Promise<void>; // POST JSON, 3 tries, 100 ms apart, swallow final failure (log warn)
  }
  // POST /guest-device/inbox → 503 when offline; 200 { result } otherwise (dropped still 200; received and duplicate trigger acknowledge, not awaited)
  // PUT /guest-device/status → 200 status; GET /guest-device/inbox → 200 { items }; DELETE /guest-device/inbox → 204 reset
  ```

- [ ] **Step 1: Write failing tests** `guest-device.service.spec.ts`: `offline returns offline and stores nothing`; `dropRate 1 returns dropped and stores nothing`; `first receive stores and returns received`; `second receive same deliveryId returns duplicate and inbox has one item`; `acknowledge retries 3 times then gives up` (stub fetch rejects, assert 3 calls).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guest-device): simulated guest device with offline, drop and dedupe`.

### Task 15: Delivery end-to-end scenarios

**Files:**
- Create: `test/helpers/wait-for.ts` (`waitFor(fn, { timeoutMs = 5000, intervalMs = 25 })`), `test/helpers/ops.ts` (`getDelivery(baseUrl, id)` using `x-api-key: test` once PR 4 lands; in PR 3 read the data file directly), `test/delivery.e2e-spec.ts`, `test/restart.e2e-spec.ts`

- [ ] **Step 1: Write failing e2e** `delivery.e2e-spec.ts`:
  - `happy path: booking is delivered, acked once, GET /:code shows acked` — inbox length 1, outbox record `acked`, `attempts === 1`.
  - `offline then online: retries with backoff until acked, device receives exactly one` — set offline, POST, `waitFor(attempts >= 3)`, assert `history` outcomes all `failed`, set online, `waitFor(status === 'acked')`, inbox length 1.
  - `drop rate 1 then 0: sent-but-lost is retried` — history has `sent` entries while still pending; after dropRate 0, acked; inbox length 1.
  - `connection refused is a failed attempt` — env `GUEST_DEVICE_INBOX_URL=http://127.0.0.1:1/inbox`; `waitFor(attempts >= 2)`; server still answers `/health` 200 (Review Focus 3).
  - `ack with wrong token is 401 and record stays pending`; `ack twice is 200 then 200 already-acked`.
  - `late ack after retry in flight does not duplicate` — offline, POST, wait attempts ≥ 1, read token from file, ack directly, then online; inbox length ≤ 1, status acked, `attempts` does not grow after ack.
- [ ] **Step 2: Write failing e2e** `restart.e2e-spec.ts`: offline, POST, `waitFor(attempts >= 1)`, `close()`, new app on the same `dataFile` and same port, online, `waitFor(acked)`, inbox length 1.
- [ ] **Step 3: Run** `pnpm test:e2e` — PASS. `pnpm test` — under 10 s.
- [ ] **Step 4: Commit** `test(e2e): delivery scenarios including offline, drop, refused and restart`.

### Task 16: Open PR 3, CI green, merge

Same steps as Task 5 (title `feat: outbox delivery with retries and acknowledgement`). Close the core time log entry: this is the end of the time-boxed deliverable.

---

## PR 4: `feat: operations`

Branch: `feat/operations`. Time: extras.

### Task 17: Ops API key guard and delivery ops endpoints

**Files:**
- Create: `src/common/ops-api-key.guard.ts`, `src/common/ops-api-key.guard.spec.ts`, `src/delivery/ops.controller.ts`, `src/delivery/ops.controller.spec.ts`, `test/ops.e2e-spec.ts`
- Modify: `src/delivery/delivery.module.ts`, `test/helpers/ops.ts`

**Interfaces:**
- Produces: `OpsApiKeyGuard` (`CanActivate`, compares `x-api-key` to `appConfig.opsApiKey` with `timingSafeEqual`, throws `UnauthorizedException`). `GET /deliveries?status=&attention=`, `GET /deliveries/:deliveryId` (404 when missing), `POST /deliveries/:deliveryId/retry-now` (200 `{ scheduled: true }`, 404). All `@UseGuards(OpsApiKeyGuard)` and `@ApiSecurity('ops')`.

- [ ] **Step 1: Failing tests** — guard: `allows matching key`, `rejects missing`, `rejects wrong`. Controller unit: list passes filters through; get 404. E2E: `GET /deliveries without key is 401`; `with key lists the pending record`; `retry-now makes the next tick send immediately` (offline, POST, wait attempts ≥ 2 with large backoff env `DELIVERY_BACKOFF_BASE_MS=5000`, call retry-now, `waitFor(attempts >= 3, 1500ms)`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ops): api-key guarded delivery inspection and retry-now`.

### Task 18: Metrics

**Files:**
- Create: `src/delivery/metrics.service.ts`, `src/delivery/metrics.service.spec.ts`, `src/delivery/metrics.controller.ts`
- Modify: `src/delivery/dispatcher.service.ts` (call `metrics.recordTick(now)` each tick and `metrics.incrementTransportFailures()` on each `TransportError`), `src/delivery/delivery.module.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MetricsSnapshot { pending: number; acked: number; needsAttention: number; attemptsHistogram: { '1': number; '2-3': number; '4-10': number; '11+': number }; timeToAckMs: { p50: number | null; p95: number | null; p99: number | null }; ticks: number; transportFailures: number; lastTickAt: string | null }
  export class MetricsService { recordTick(now: Date); incrementTransportFailures(); snapshot(): Promise<MetricsSnapshot> } // computed from outbox + own counters; the dispatcher calls recordTick so MetricsService never depends on DispatcherService
  // GET /metrics → 200 MetricsSnapshot, guarded by OpsApiKeyGuard
  ```

- [ ] **Step 1: Failing tests**: `counts pending and acked`; `buckets attempts`; `computes time-to-ack percentiles from createdAt→ackedAt` (5 records, exact p50); `null percentiles when nothing acked`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (nearest-rank percentile). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ops): metrics snapshot for SLO measurement`.

### Task 19: Attention alerting with optional Sentry sink

**Files:**
- Create: `src/common/alerts.service.ts`, `src/common/alerts.service.spec.ts`, `src/instrument.ts`
- Modify: `src/delivery/outbox.service.ts` (emit `delivery.attention` event when the flag flips), `src/main.ts` (`import './instrument'` first line), `src/app.module.ts` (`SentryModule.forRoot()` + `SentryGlobalFilter` only when `SENTRY_DSN` set)

**Interfaces:**
- Produces: `AlertsService.@OnEvent('delivery.attention') onAttention(e: { deliveryId; attempts })` logs at error level and calls `Sentry.captureMessage` when `appConfig.sentryDsn` is set. `instrument.ts` calls `Sentry.init({ dsn })` only when `SENTRY_DSN` is set.

- [ ] **Step 1: Failing tests**: `logs error on attention`; `calls sentry when dsn set`; `does not call sentry when dsn unset`; outbox: `emits delivery.attention exactly once when crossing the threshold`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ops): attention alerts with env-gated sentry`.

### Task 20: Demo script

**Files:**
- Create: `scripts/demo.ts`
- Modify: `package.json` (`"demo": "tsx scripts/demo.ts"`, add `tsx` dev dep)

- [ ] **Step 1: Implement** — against `BASE_URL` (default `http://localhost:3000`) and `OPS_API_KEY`: set device offline, POST a booking, poll `GET /deliveries/:id` three times printing `attempts`, `nextAttemptAt`, last history outcome; set online; poll until `acked`; print `GET /:code`. Output is a numbered narrative, one line per step.
- [ ] **Step 2: Verify** — run the server with `OPS_API_KEY=demo`, run `OPS_API_KEY=demo pnpm demo`, paste the output into the PR description.
- [ ] **Step 3: Commit** `feat(ops): demo script for the offline-then-online scenario`.

### Task 21: Open PR 4, CI green, merge

Same steps as Task 5 (title `feat: operations endpoints, metrics, alerts, demo`).

---

## PR 5: `feat: pubsub transport`

Branch: `feat/pubsub-transport`. Time: extras.

### Task 22: Pub/Sub transport, consumer, emulator setup

**Files:**
- Create: `src/delivery/transport/pubsub.transport.ts`, `src/delivery/transport/pubsub.transport.spec.ts`, `src/delivery/transport/pubsub.consumer.ts`, `src/delivery/transport/pubsub.consumer.spec.ts`, `src/delivery/transport/pubsub.client.ts`, `scripts/setup-pubsub-emulator.ts`, `scripts/emulator.sh`, `docker-compose.yml`, `test/pubsub.integration-spec.ts`
- Modify: `src/delivery/transport/transport.provider.ts`, `src/delivery/delivery.module.ts`, `package.json` (`"emulator": "bash scripts/emulator.sh"`, `"emulator:setup": "tsx scripts/setup-pubsub-emulator.ts"`), `.github/workflows/ci.yml` (job `pubsub-integration`)

**Interfaces:**
- Produces:
  ```ts
  export const PUBSUB_CLIENT = Symbol('PUBSUB_CLIENT'); // PubSub | null, null when !pubsubConfig.enabled
  export class PubSubTransport implements DeliveryTransport { constructor(pubsub: PubSub, topic: string); send(payload): Promise<'handed-off'> } // publishMessage({ json: payload })
  export class PubSubConsumer implements OnModuleInit, OnModuleDestroy {
    constructor(pubsub: PubSub | null, subscription: string, webhook: WebhookTransport, outbox: OutboxService, clock: Clock, drainMs: number)
    handle(message: Message): Promise<void>; // parse DeliveryPayload → webhook.send → outbox.recordOutcome('sent' | kind) → message.ack() always
  }
  ```
  `transport.provider.ts`: `pubsubConfig.enabled ? PubSubTransport : WebhookTransport`. The consumer is registered only when enabled. `scripts/emulator.sh`: `gcloud beta emulators pubsub start --host-port=localhost:8085 --project=booking-local`. `docker-compose.yml`: the `google-cloud-cli:emulators` image on 8085. `setup-pubsub-emulator.ts`: create topic and subscription (ack deadline 60 s), idempotent on ALREADY_EXISTS (gRPC code 6). CI job: `docker run -d` the emulator, wait on port, `emulator:setup`, `pnpm test:e2e -- pubsub` with `PUBSUB_EMULATOR_HOST=localhost:8085`.

- [ ] **Step 1: Failing unit tests** — transport: `publishes the payload as json and resolves handed-off`. Consumer: `records sent and acks on webhook success`; `records failed and still acks on webhook failure`; `acks and logs on malformed json without touching the outbox`; `onModuleDestroy waits for in-flight handlers`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Integration test** `pubsub.integration-spec.ts` — `const d = process.env.PUBSUB_EMULATOR_HOST ? describe : describe.skip`; happy path and offline-then-online through the Pub/Sub transport, asserting `history[0].outcome === 'sent'` and that attempts only grow by the outbox schedule.
- [ ] **Step 6: Run locally** — terminal 1 `pnpm emulator`; terminal 2 `pnpm emulator:setup && PUBSUB_EMULATOR_HOST=localhost:8085 pnpm test:e2e -- pubsub` — PASS. Without the env var the suite is skipped and `pnpm test:e2e` still passes.
- [ ] **Step 7: Commit** `feat(delivery): optional pub/sub transport with outbox-owned retries`.

### Task 23: Open PR 5, CI green (both jobs), merge

Same steps as Task 5 (title `feat: optional Google Pub/Sub transport`). Add `pubsub-integration` to the required status checks.

---

## PR 6: `docs: readme, decisions, diagram, dockerfile`

Branch: `docs/readme-and-diagram`. Time: extras.

### Task 24: Dockerfile

**Files:**
- Create: `Dockerfile`, `.dockerignore`

- [ ] **Step 1: Write** — stage 1 `node:22-alpine`: corepack enable, copy manifests, `pnpm install --frozen-lockfile`, copy source, `pnpm build`, `pnpm prune --prod`. Stage 2 `node:22-slim`: `curl` installed, user `nodejs` uid 1001, copy `dist`, `node_modules`, `package.json`, `mkdir /app/data` owned by `nodejs`, `ENV NODE_ENV=production PORT=3000 DATA_FILE=/app/data/store.json`, `HEALTHCHECK` curl `/health`, `CMD ["node", "dist/main"]`.
- [ ] **Step 2: Verify** — Docker is not installed locally; add a CI step `docker build -t bcd:ci .` to the `check` job and rely on it. Expected: CI green.
- [ ] **Step 3: Commit** `build: multi-stage dockerfile with non-root user and healthcheck`.

### Task 25: FigJam diagram (main agent, Figma MCP)

- [ ] **Step 1:** Load `figma:figma-generate-diagram`, then `generate_diagram` with a Mermaid sequence diagram: `Client → API: POST /bookings`; `API → FileStore: atomic write (booking + outbox)`; `API → Client: 202`; `Dispatcher → GuestDevice: POST inbox (attempt n)`; `GuestDevice → API: POST /deliveries/:id/ack`; `Dispatcher → FileStore: acked`; alt branch `device offline → backoff → retry`. Plus a second diagram: architecture boxes (Bookings, Outbox/Dispatcher, Transport port with Webhook and Pub/Sub, Guest Device, FileStore, Ops/Metrics/Health).
- [ ] **Step 2:** Add a decision panel (sticky notes) with the four decisions from spec section 13 and the six README decision records.
- [ ] **Step 3:** Record the FigJam URL for the README.

### Task 26: README, decision records, time log

**Files:**
- Modify: `README.md`, `docs/time-log.md`
- Create: `docs/decisions.md`

- [ ] **Step 1: Write `docs/decisions.md`** — one short record each: outbox over queue; no automatic dead-letter; file snapshots over append log; simulator in-process; Redis excluded; Pub/Sub as optional transport; `forbidNonWhitelisted` on; case-insensitive codes; 404 JSON body for unknown code; 202 without code. Each: context, decision, consequence, how to reverse.
- [ ] **Step 2: Write `README.md`** per spec section 10: run in one command (`cp .env.example .env && pnpm install && pnpm start:dev`), the booking sequence, offline behaviour, assumptions, link to decisions, production path (Postgres outbox with `FOR UPDATE SKIP LOCKED`, multi-instance leases, real channel providers, secrets), SLO (99 % acked within 60 s while online, measured by `/metrics` `timeToAckMs.p99`), AI usage section, FigJam link, time log table with core and extras rows, demo transcript.
- [ ] **Step 3: Verify** — follow the README's run command on a clean clone (`git clone` into the scratchpad) and confirm it boots and the demo runs.
- [ ] **Step 4: Commit** `docs: readme, decision records, time log, diagram link`.

### Task 27: Open PR 6, CI green, merge

Same steps as Task 5 (title `docs: readme, decisions, diagram, dockerfile`). After merge, confirm `main` is green and the README renders on GitHub.
