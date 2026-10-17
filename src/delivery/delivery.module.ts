import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { deliveryConfig } from '../config/delivery.config';
import { BackoffPolicy } from './backoff.policy';
import { OutboxService } from './outbox.service';

@Module({
  providers: [
    {
      provide: BackoffPolicy,
      useFactory: (cfg: ConfigType<typeof deliveryConfig>) =>
        new BackoffPolicy(cfg.backoffBaseMs, cfg.backoffMaxMs),
      inject: [deliveryConfig.KEY],
    },
    OutboxService,
  ],
  exports: [OutboxService],
})
export class DeliveryModule {}
