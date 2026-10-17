import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { deliveryConfig } from '../config/delivery.config';
import {
  own,
  STORAGE,
  type OutboxOutcome,
  type OutboxRecord,
  type StoragePort,
} from '../storage/storage.port';
import { BackoffPolicy } from './backoff.policy';
import {
  DELIVERY_ATTENTION,
  type DeliveryAttentionEvent,
} from './events/delivery-attention.event';

const HISTORY_CAP = 50;

export type AckResult =
  'acked' | 'already-acked' | 'invalid-token' | 'not-found';

export interface OutboxListFilter {
  status?: OutboxRecord['status'];
  attention?: boolean;
}

/** The single retry authority: every outbox state transition goes through here. */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(STORAGE) private readonly storage: StoragePort,
    private readonly backoff: BackoffPolicy,
    @Inject(deliveryConfig.KEY)
    private readonly cfg: ConfigType<typeof deliveryConfig>,
    private readonly events: EventEmitter2,
  ) {}

  async claimDue(now: Date, leaseMs: number): Promise<OutboxRecord[]> {
    const nowMs = now.getTime();
    const { claimed, attention } = await this.storage.mutate((draft) => {
      const records = Object.values(draft.outbox);
      // Expired here => never claimed in this call, even if backoff is 0.
      const expired = new Set<string>();
      const attention: DeliveryAttentionEvent[] = [];
      for (const record of records) {
        if (
          record.status === 'pending' &&
          record.leaseUntil !== null &&
          Date.parse(record.leaseUntil) < nowMs
        ) {
          if (this.applyOutcome(record, 'lease-expired', now)) {
            attention.push(attentionEvent(record));
          }
          expired.add(record.deliveryId);
        }
      }
      const claimed: OutboxRecord[] = [];
      for (const record of records) {
        if (
          !expired.has(record.deliveryId) &&
          this.isClaimable(record, nowMs)
        ) {
          record.leaseUntil = new Date(nowMs + leaseMs).toISOString();
          claimed.push(record);
        }
      }
      return { claimed, attention };
    });
    for (const e of attention) this.events.emit(DELIVERY_ATTENTION, e);
    return claimed;
  }

  claimOne(
    deliveryId: string,
    now: Date,
    leaseMs: number,
  ): Promise<OutboxRecord | null> {
    const nowMs = now.getTime();
    return this.storage.mutate((draft) => {
      const record = own(draft.outbox, deliveryId);
      if (record === undefined || !this.isClaimable(record, nowMs)) {
        return null;
      }
      record.leaseUntil = new Date(nowMs + leaseMs).toISOString();
      return record;
    });
  }

  async recordOutcome(
    deliveryId: string,
    outcome: OutboxOutcome,
    now: Date,
    error?: string,
  ): Promise<OutboxRecord | null> {
    const result = await this.storage.mutate((draft) => {
      const record = own(draft.outbox, deliveryId);
      if (record === undefined) return null;
      if (record.status === 'acked') {
        // Ack never reopens a delivery; outcomes are still counted.
        countAttempt(record, outcome, now, error);
        return { record, flagged: false };
      }
      const flagged = this.applyOutcome(record, outcome, now, error);
      return { record, flagged };
    });
    if (result === null) return null;
    // After mutate resolves, so the flag is persisted before anyone is alerted.
    if (result.flagged) {
      this.events.emit(DELIVERY_ATTENTION, attentionEvent(result.record));
    }
    return result.record;
  }

  /** Returns claimed-but-unsent records to the queue without counting an attempt. */
  releaseLease(deliveryIds: string[], now: Date): Promise<number> {
    return this.storage.mutate((draft) => {
      let released = 0;
      for (const id of deliveryIds) {
        const record = own(draft.outbox, id);
        if (record?.status !== 'pending' || record.leaseUntil === null) {
          continue;
        }
        record.leaseUntil = null;
        record.nextAttemptAt = now.toISOString();
        released += 1;
      }
      return released;
    });
  }

  ack(deliveryId: string, ackToken: string, now: Date): Promise<AckResult> {
    return this.storage.mutate((draft): AckResult => {
      const record = own(draft.outbox, deliveryId);
      if (record === undefined) return 'not-found';
      if (!tokensMatch(record.ackToken, ackToken)) return 'invalid-token';
      if (record.status === 'acked') return 'already-acked';
      record.status = 'acked';
      record.ackedAt = now.toISOString();
      record.leaseUntil = null;
      return 'acked';
    });
  }

  retryNow(deliveryId: string, now: Date): Promise<boolean> {
    return this.storage.mutate((draft) => {
      const record = own(draft.outbox, deliveryId);
      if (record === undefined || record.status !== 'pending') return false;
      record.nextAttemptAt = now.toISOString();
      // A live lease means a send is in flight: keep it, so no second send
      // starts concurrently. Its outcome schedules the next attempt.
      const leaseLive =
        record.leaseUntil !== null &&
        Date.parse(record.leaseUntil) >= now.getTime();
      if (!leaseLive) record.leaseUntil = null;
      return true;
    });
  }

  async list(filter: OutboxListFilter): Promise<OutboxRecord[]> {
    const state = await this.storage.read();
    return Object.values(state.outbox)
      .filter(
        (r) =>
          (filter.status === undefined || r.status === filter.status) &&
          (filter.attention === undefined ||
            r.needsAttention === filter.attention),
      )
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async get(deliveryId: string): Promise<OutboxRecord | null> {
    const state = await this.storage.read();
    return own(state.outbox, deliveryId) ?? null;
  }

  private isClaimable(record: OutboxRecord, nowMs: number): boolean {
    return (
      record.status === 'pending' &&
      record.leaseUntil === null &&
      Date.parse(record.nextAttemptAt) <= nowMs
    );
  }

  /** Returns true when this outcome is the one that flags the record for attention. */
  private applyOutcome(
    record: OutboxRecord,
    outcome: OutboxOutcome,
    now: Date,
    error?: string,
  ): boolean {
    countAttempt(record, outcome, now, error);
    record.leaseUntil = null;
    record.nextAttemptAt = new Date(
      now.getTime() + this.backoff.delayMs(record.attempts),
    ).toISOString();
    if (
      !record.needsAttention &&
      record.attempts >= this.cfg.attentionAfterAttempts
    ) {
      record.needsAttention = true;
      return true;
    }
    return false;
  }
}

/** The bookkeeping every outcome gets, acked or not: count, history, lastSentAt. */
function countAttempt(
  record: OutboxRecord,
  outcome: OutboxOutcome,
  now: Date,
  error?: string,
): void {
  const iso = now.toISOString();
  record.attempts += 1;
  record.history.push({
    at: iso,
    attempt: record.attempts,
    outcome,
    ...(error === undefined ? {} : { error }),
  });
  if (record.history.length > HISTORY_CAP) {
    record.history = record.history.slice(-HISTORY_CAP);
  }
  if (outcome === 'sent') record.lastSentAt = iso;
}

function attentionEvent(record: OutboxRecord): DeliveryAttentionEvent {
  return { deliveryId: record.deliveryId, attempts: record.attempts };
}

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
