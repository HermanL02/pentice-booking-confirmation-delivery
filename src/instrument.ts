// Loads .env into process.env before anything reads it. main.ts imports this
// file first, and both this file and app.module.ts read SENTRY_DSN before
// ConfigModule runs, so a DSN set only in .env would otherwise be missed.
// .env stays the single source of truth: ConfigModule reads the same file
// later and, like dotenv, never overrides a variable that is already set.
import { config } from 'dotenv';
import * as Sentry from '@sentry/nestjs';

config({ quiet: true });

// Without SENTRY_DSN nothing is initialised and the SDK stays inert.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
  });
}
