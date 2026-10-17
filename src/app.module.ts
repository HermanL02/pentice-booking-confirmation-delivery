import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { CommonModule } from './common/common.module';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { buildPinoTransport } from './common/logger.transport';
import { appConfig } from './config/app.config';
import { deliveryConfig } from './config/delivery.config';
import { envSchema } from './config/env.schema';
import { pubsubConfig } from './config/pubsub.config';
import { HealthModule } from './health/health.module';

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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    CommonModule,
    HealthModule,
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('{*path}');
  }
}
