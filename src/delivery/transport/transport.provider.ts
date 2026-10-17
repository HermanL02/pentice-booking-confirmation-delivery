import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { deliveryConfig } from '../../config/delivery.config';
import { DELIVERY_TRANSPORT } from './delivery-transport.port';
import { WebhookTransport } from './webhook.transport';

export const deliveryTransportProvider: Provider = {
  provide: DELIVERY_TRANSPORT,
  useFactory: (delivery: ConfigType<typeof deliveryConfig>) =>
    new WebhookTransport(delivery.guestDeviceInboxUrl, delivery.timeoutMs),
  inject: [deliveryConfig.KEY],
};
