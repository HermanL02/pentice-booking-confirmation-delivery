import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { appConfig } from './config/app.config';
import { deliveryConfig } from './config/delivery.config';
import { envSchema } from './config/env.schema';
import { pubsubConfig } from './config/pubsub.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      validationOptions: { abortEarly: false },
      load: [appConfig, deliveryConfig, pubsubConfig],
    }),
  ],
  controllers: [AppController],
})
export class AppModule {}
