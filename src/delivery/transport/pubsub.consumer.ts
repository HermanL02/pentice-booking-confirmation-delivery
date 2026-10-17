import type { Message, PubSub, Subscription } from '@google-cloud/pubsub';
import {
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock';
import {
  deliveryConfig,
  type DeliveryConfig,
} from '../../config/delivery.config';
import { pubsubConfig, type PubSubConfig } from '../../config/pubsub.config';
import type { OutboxOutcome } from '../../storage/storage.port';
import { OutboxService } from '../outbox.service';
import {
  TransportError,
  type DeliveryPayload,
} from './delivery-transport.port';
import { PUBSUB_CLIENT } from './pubsub.client';
import { WebhookTransport } from './webhook.transport';

const MAX_MESSAGES = 10;

/**
 * Pulls handed-off deliveries from Pub/Sub, posts them to the guest device and
 * records the outcome in the outbox. Every message is acked, failures
 * included: the outbox owns retries, so the broker must never redeliver.
 */
export class PubSubConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PubSubConsumer.name);
  private readonly inFlight = new Set<Promise<void>>();
  private subscription: Subscription | null = null;
  private readonly onMessage = (message: Message): void => {
    void this.track(this.handle(message));
  };
  private readonly onError = (err: Error): void => {
    this.logger.error(`subscription error: ${err.message}`);
  };

  constructor(
    private readonly pubsub: PubSub | null,
    private readonly subscriptionName: string,
    private readonly webhook: WebhookTransport,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly drainMs: number,
  ) {}

  onModuleInit(): void {
    if (this.pubsub === null) {
      this.logger.log('pub/sub disabled, consumer not started');
      return;
    }
    this.subscription = this.pubsub.subscription(this.subscriptionName, {
      flowControl: { maxMessages: MAX_MESSAGES },
    });
    this.subscription.on('message', this.onMessage);
    this.subscription.on('error', this.onError);
    this.logger.log(`consuming ${this.subscriptionName}`);
  }

  /** Never rejects; always acks, after the outcome is in the outbox. */
  async handle(message: Message): Promise<void> {
    const payload = parsePayload(message);
    if (payload === null) {
      this.logger.warn(`dropping malformed message id=${message.id}`);
      message.ack();
      return;
    }
    const { deliveryId } = payload;
    let outcome: OutboxOutcome = 'sent';
    let error: string | undefined;
    try {
      await this.webhook.send(payload);
    } catch (err) {
      outcome = err instanceof TransportError ? err.kind : 'failed';
      error = err instanceof TransportError ? err.message : String(err);
    }
    try {
      const now = this.clock.now();
      if (error === undefined) {
        await this.outbox.recordOutcome(deliveryId, outcome, now);
      } else {
        await this.outbox.recordOutcome(deliveryId, outcome, now, error);
      }
    } catch (err) {
      this.logger.error(
        `recording outcome failed deliveryId=${deliveryId} outcome=${outcome}: ${String(err)}`,
      );
    } finally {
      message.ack();
    }
  }

  async onModuleDestroy(): Promise<void> {
    const subscription = this.subscription;
    if (subscription === null) return;
    subscription.removeListener('message', this.onMessage);
    if (this.inFlight.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), this.drainMs);
        timer.unref();
      });
      const drained = Promise.allSettled([...this.inFlight]).then(() => false);
      try {
        if (await Promise.race([drained, timedOut])) {
          this.logger.warn(
            `shutdown drain limit reached with ${this.inFlight.size} message(s) still in flight`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }
    await subscription.close();
    subscription.removeListener('error', this.onError);
    this.subscription = null;
  }

  private track(op: Promise<void>): Promise<void> {
    const p = op.finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
    return p;
  }
}

function parsePayload(message: Message): DeliveryPayload | null {
  try {
    const parsed = JSON.parse(message.data.toString()) as unknown;
    return typeof (parsed as Partial<DeliveryPayload> | null)?.deliveryId ===
      'string'
      ? (parsed as DeliveryPayload)
      : null;
  } catch {
    return null;
  }
}

export const pubsubConsumerProvider: Provider = {
  provide: PubSubConsumer,
  useFactory: (
    pubsub: PubSub | null,
    pubsubCfg: PubSubConfig,
    delivery: DeliveryConfig,
    outbox: OutboxService,
    clock: Clock,
  ) =>
    new PubSubConsumer(
      pubsub,
      pubsubCfg.subscription,
      new WebhookTransport(delivery.guestDeviceInboxUrl, delivery.timeoutMs),
      outbox,
      clock,
      delivery.shutdownDrainMs,
    ),
  inject: [
    PUBSUB_CLIENT,
    pubsubConfig.KEY,
    deliveryConfig.KEY,
    OutboxService,
    CLOCK,
  ],
};
