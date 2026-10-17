import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { BookingsModule } from './bookings/bookings.module';
import { CommonModule } from './common/common.module';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { buildPinoTransport } from './common/logger.transport';
import { appConfig } from './config/app.config';
import { deliveryConfig } from './config/delivery.config';
import { envSchema } from './config/env.schema';
import { pubsubConfig } from './config/pubsub.config';
import { DeliveryModule } from './delivery/delivery.module';
import { GuestDeviceModule } from './guest-device/guest-device.module';
import { HealthModule } from './health/health.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
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
          genReqId: (req: { id?: unknown }) => req.id as string,
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
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('{*path}');
  }
}
