import type { PubSub } from '@google-cloud/pubsub';
import type { Provider } from '@nestjs/common';
import {
  deliveryConfig,
  type DeliveryConfig,
} from '../../config/delivery.config';
import { pubsubConfig, type PubSubConfig } from '../../config/pubsub.config';
import { DELIVERY_TRANSPORT } from './delivery-transport.port';
import { PUBSUB_CLIENT } from './pubsub.client';
import { PubSubTransport } from './pubsub.transport';
import { WebhookTransport } from './webhook.transport';

export const deliveryTransportProvider: Provider = {
  provide: DELIVERY_TRANSPORT,
  useFactory: (
    delivery: DeliveryConfig,
    pubsubCfg: PubSubConfig,
    pubsub: PubSub | null,
  ) =>
    pubsubCfg.enabled && pubsub
      ? new PubSubTransport(pubsub, pubsubCfg.topic)
      : new WebhookTransport(delivery.guestDeviceInboxUrl, delivery.timeoutMs),
  inject: [deliveryConfig.KEY, pubsubConfig.KEY, PUBSUB_CLIENT],
};
