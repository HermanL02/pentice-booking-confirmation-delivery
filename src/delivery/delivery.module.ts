import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { deliveryConfig } from '../config/delivery.config';
import { AckController } from './ack.controller';
import { BackoffPolicy } from './backoff.policy';
import { DispatcherService } from './dispatcher.service';
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
    DispatcherService,
  ],
  exports: [OutboxService, DELIVERY_TRANSPORT, DispatcherService],
})
export class DeliveryModule {}
