import type { PubSub } from '@google-cloud/pubsub';
import {
  TransportError,
  type DeliveryPayload,
  type DeliveryTransport,
} from './delivery-transport.port';

/**
 * Hands the payload to Pub/Sub. The outcome is recorded later by
 * PubSubConsumer, so the dispatcher leaves the lease in place.
 */
export class PubSubTransport implements DeliveryTransport {
  constructor(
    private readonly pubsub: PubSub,
    private readonly topic: string,
  ) {}

  async send(payload: DeliveryPayload): Promise<'handed-off'> {
    try {
      await this.pubsub.topic(this.topic).publishMessage({ json: payload });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TransportError(message, 'failed', { cause: err });
    }
    return 'handed-off';
  }
}
