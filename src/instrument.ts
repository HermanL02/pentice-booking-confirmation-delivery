import * as Sentry from '@sentry/nestjs';

// Imported first by main.ts so Sentry can instrument modules as they load.
// Without SENTRY_DSN nothing is initialised and the SDK stays inert.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
  });
}
