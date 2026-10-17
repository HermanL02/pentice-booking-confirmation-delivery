import {
  Duration,
  type Message,
  type PubSub,
  type Subscription,
  type SubscriberOptions,
} from '@google-cloud/pubsub';
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

type CloseBehavior = NonNullable<
  NonNullable<SubscriberOptions['closeOptions']>['behavior']
>;
/**
 * SubscriberCloseBehaviors.WaitForProcessing; the enum is not re-exported from
 * the package index, the type keeps this literal honest. The default (NACK)
 * would nack every message still being handled on close, and Pub/Sub would
 * redeliver what the consumer is about to finish.
 */
const WAIT_FOR_PROCESSING: CloseBehavior = 'WAIT';

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
      closeOptions: {
        behavior: WAIT_FOR_PROCESSING,
        timeout: Duration.from({ milliseconds: this.drainMs }),
      },
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

  /**
   * Keeps the 'message' listener attached while draining: removing the last
   * one makes the library close (and nack) on its own. Messages that arrive
   * meanwhile are handled normally (flow control bounds them); close() then
   * stops the stream and waits for the rest.
   */
  async onModuleDestroy(): Promise<void> {
    const subscription = this.subscription;
    if (subscription === null) return;
    this.subscription = null;
    await this.drain();
    try {
      await subscription.close();
    } catch (err) {
      this.logger.error(`closing subscription failed: ${String(err)}`);
    } finally {
      subscription.removeListener('message', this.onMessage);
      subscription.removeListener('error', this.onError);
    }
  }

  private async drain(): Promise<void> {
    if (this.inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.drainMs);
      timer.unref();
    });
    try {
      // Loop: handlers that start during the drain are awaited too.
      while (this.inFlight.size > 0 && !timedOut) {
        await Promise.race([Promise.allSettled([...this.inFlight]), deadline]);
      }
      if (timedOut) {
        this.logger.warn(
          `shutdown drain limit reached with ${this.inFlight.size} message(s) still in flight`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
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
