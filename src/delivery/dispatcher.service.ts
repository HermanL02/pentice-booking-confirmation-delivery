import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  BOOKING_CREATED,
  BookingCreatedEvent,
} from '../bookings/events/booking-created.event';
import { CLOCK, type Clock } from '../common/clock';
import { appConfig } from '../config/app.config';
import { deliveryConfig } from '../config/delivery.config';
import type { OutboxOutcome, OutboxRecord } from '../storage/storage.port';
import { OutboxService } from './outbox.service';
import {
  DELIVERY_TRANSPORT,
  TransportError,
  toPayload,
  type DeliveryTransport,
} from './transport/delivery-transport.port';

const INTERVAL_NAME = 'dispatcher';
const MAX_CONCURRENCY = 10;

/** Drains the outbox: claims due records, sends them and records outcomes. */
@Injectable()
export class DispatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DispatcherService.name);
  private readonly inFlight = new Set<Promise<void>>();
  private ticking = false;
  private stopping = false;
  private lastTick: Date | null = null;

  constructor(
    private readonly outbox: OutboxService,
    @Inject(DELIVERY_TRANSPORT) private readonly transport: DeliveryTransport,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(deliveryConfig.KEY)
    private readonly cfg: ConfigType<typeof deliveryConfig>,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  get lastTickAt(): Date | null {
    return this.lastTick;
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const now = this.clock.now();
      this.lastTick = now;
      const due = await this.outbox.claimDue(now, this.cfg.leaseMs);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < due.length && !this.stopping) {
          await this.track(due[next++]);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENCY, due.length) }, worker),
      );
    } catch (err) {
      this.logger.error(`tick failed: ${describe(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  async dispatchOne(deliveryId: string): Promise<void> {
    if (this.stopping) return;
    const record = await this.outbox.claimOne(
      deliveryId,
      this.clock.now(),
      this.cfg.leaseMs,
    );
    if (record === null) return;
    await this.track(record);
  }

  /** Must never reject: the event is emitted synchronously after persisting a booking. */
  @OnEvent(BOOKING_CREATED)
  async onBookingCreated(e: BookingCreatedEvent): Promise<void> {
    try {
      await this.dispatchOne(e.deliveryId);
    } catch (err) {
      this.logger.error(
        `immediate dispatch failed deliveryId=${e.deliveryId}: ${describe(err)}`,
      );
    }
  }

  onApplicationBootstrap(): void {
    const interval = setInterval(() => void this.tick(), this.cfg.tickMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
    if (this.inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), this.cfg.shutdownDrainMs);
      timer.unref();
    });
    const drained = Promise.allSettled([...this.inFlight]).then(() => false);
    try {
      if (await Promise.race([drained, timedOut])) {
        this.logger.warn(
          `shutdown drain limit reached with ${this.inFlight.size} send(s) still in flight`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private track(record: OutboxRecord): Promise<void> {
    const p = this.process(record).finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
    return p;
  }

  /** Never rejects, so one bad record cannot abort a tick. */
  private async process(record: OutboxRecord): Promise<void> {
    const { deliveryId } = record;
    let outcome: OutboxOutcome;
    let error: string | undefined;
    try {
      const result = await this.transport.send(
        toPayload(record, this.app.publicBaseUrl),
      );
      if (result === 'handed-off') return;
      outcome = 'sent';
    } catch (err) {
      outcome = err instanceof TransportError ? err.kind : 'failed';
      error = describe(err);
    }
    const now = this.clock.now();
    try {
      const updated =
        error === undefined
          ? await this.outbox.recordOutcome(deliveryId, outcome, now)
          : await this.outbox.recordOutcome(deliveryId, outcome, now, error);
      const line = `delivery attempt deliveryId=${deliveryId} attempt=${updated?.attempts ?? '-'} outcome=${outcome} nextAttemptAt=${updated?.nextAttemptAt ?? '-'}`;
      if (outcome === 'sent') this.logger.log(line);
      else this.logger.warn(`${line} error=${error}`);
    } catch (err) {
      this.logger.error(
        `recording outcome failed deliveryId=${deliveryId} outcome=${outcome}: ${describe(err)}`,
      );
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
