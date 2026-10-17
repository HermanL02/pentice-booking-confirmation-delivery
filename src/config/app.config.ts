import { registerAs, type ConfigType } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  env: process.env.NODE_ENV as string,
  port: Number(process.env.PORT),
  publicBaseUrl: process.env.PUBLIC_BASE_URL as string,
  dataFile: process.env.DATA_FILE as string,
  storageLatencyMs: Number(process.env.STORAGE_LATENCY_MS),
  opsApiKey: process.env.OPS_API_KEY as string,
  logLevel: process.env.LOG_LEVEL as string,
  sentryDsn: process.env.SENTRY_DSN,
  betterstackSourceToken: process.env.BETTERSTACK_SOURCE_TOKEN,
  betterstackIngestHost: process.env.BETTERSTACK_INGEST_HOST as string,
}));

export type AppConfig = ConfigType<typeof appConfig>;
