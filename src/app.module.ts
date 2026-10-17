import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { BookingsModule } from './bookings/bookings.module';
import { CommonModule } from './common/common.module';
import { correlationIdFor } from './common/correlation-id';
import { buildPinoTransport } from './common/logger.transport';
import { appConfig } from './config/app.config';
import { deliveryConfig } from './config/delivery.config';
import { envSchema } from './config/env.schema';
import { pubsubConfig } from './config/pubsub.config';
import { DeliveryModule } from './delivery/delivery.module';
import { GuestDeviceModule } from './guest-device/guest-device.module';
import { HealthModule } from './health/health.module';
import { StorageModule } from './storage/storage.module';

// Sentry is wired only when a DSN is configured (see instrument.ts).
const sentryEnabled = Boolean(process.env.SENTRY_DSN);

@Module({
  imports: [
    ...(sentryEnabled ? [SentryModule.forRoot()] : []),
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      validationOptions: { abortEarly: false },
      load: [appConfig, deliveryConfig, pubsubConfig],
    }),
    LoggerModule.forRootAsync({
      inject: [appConfig.KEY],
      useFactory: (cfg: ConfigType<typeof appConfig>) => ({
        pinoHttp: {
          genReqId: correlationIdFor,
          customProps: (req: IncomingMessage) => ({ correlationId: req.id }),
          level: cfg.logLevel,
          transport: buildPinoTransport(cfg),
        },
      }),
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [appConfig.KEY],
      useFactory: (cfg: ConfigType<typeof appConfig>) => [
        { ttl: 60_000, limit: cfg.throttleLimitPerMinute },
      ],
    }),
    CommonModule,
    HealthModule,
    StorageModule,
    DeliveryModule,
    GuestDeviceModule,
    BookingsModule,
  ],
  controllers: [AppController],
  providers: sentryEnabled
    ? [{ provide: APP_FILTER, useClass: SentryGlobalFilter }]
    : [],
})
export class AppModule {}
