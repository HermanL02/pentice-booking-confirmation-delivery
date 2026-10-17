import * as Joi from 'joi';

const positiveInt = (def: number) =>
  Joi.number().integer().positive().default(def);
const optionalString = () => Joi.string().allow('');

export const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: positiveInt(3000),
  PUBLIC_BASE_URL: Joi.string().uri().default('http://localhost:3000'),
  DATA_FILE: Joi.string().default('./data/store.json'),
  STORAGE_LATENCY_MS: Joi.number().integer().min(0).default(0),
  OPS_API_KEY: Joi.string().required(),
  GUEST_DEVICE_INBOX_URL: Joi.string()
    .uri()
    .default('http://localhost:3000/guest-device/inbox'),
  DELIVERY_TICK_MS: positiveInt(1000),
  DELIVERY_TIMEOUT_MS: positiveInt(3000),
  DELIVERY_LEASE_MS: positiveInt(15000),
  DELIVERY_BACKOFF_BASE_MS: positiveInt(1000),
  DELIVERY_BACKOFF_MAX_MS: positiveInt(300000),
  DELIVERY_ATTENTION_AFTER_ATTEMPTS: positiveInt(10),
  SHUTDOWN_DRAIN_MS: positiveInt(10000),
  LOG_LEVEL: Joi.string().default('info'),
  THROTTLE_LIMIT_PER_MINUTE: positiveInt(100),
  SENTRY_DSN: optionalString(),
  BETTERSTACK_SOURCE_TOKEN: optionalString(),
  BETTERSTACK_INGEST_HOST: Joi.string().default(
    'https://in.logs.betterstack.com',
  ),
  PUBSUB_EMULATOR_HOST: optionalString(),
  GCP_PROJECT_ID: Joi.string().default('booking-local'),
  PUBSUB_TOPIC: Joi.string().default('confirmation-deliveries'),
  PUBSUB_SUBSCRIPTION: Joi.string().default('confirmation-deliveries-sub'),
});
