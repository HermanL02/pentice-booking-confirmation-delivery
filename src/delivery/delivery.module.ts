import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { deliveryConfig } from '../config/delivery.config';
import { AckController } from './ack.controller';
import { BackoffPolicy } from './backoff.policy';
import { OutboxService } from './outbox.service';
import { DELIVERY_TRANSPORT } from './transport/delivery-transport.port';
import { deliveryTransportProvider } from './transport/transport.provider';

@Module({
  controllers: [AckController],
  providers: [
    {
      provide: BackoffPolicy,
      useFactory: (cfg: ConfigType<typeof deliveryConfig>) =>
        new BackoffPolicy(cfg.backoffBaseMs, cfg.backoffMaxMs),
      inject: [deliveryConfig.KEY],
    },
    OutboxService,
    deliveryTransportProvider,
  ],
  exports: [OutboxService, DELIVERY_TRANSPORT],
})
export class DeliveryModule {}
