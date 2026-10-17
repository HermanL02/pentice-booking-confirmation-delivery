import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { deliveryConfig } from '../config/delivery.config';
import {
  STORAGE,
  type OutboxOutcome,
  type OutboxRecord,
  type StoragePort,
} from '../storage/storage.port';
import { BackoffPolicy } from './backoff.policy';

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
  ) {}

  claimDue(now: Date, leaseMs: number): Promise<OutboxRecord[]> {
    const nowMs = now.getTime();
    return this.storage.mutate((draft) => {
      const records = Object.values(draft.outbox);
      // Expired here => never claimed in this call, even if backoff is 0.
      const expired = new Set<string>();
      for (const record of records) {
        if (
          record.status === 'pending' &&
          record.leaseUntil !== null &&
          Date.parse(record.leaseUntil) < nowMs
        ) {
          this.applyOutcome(record, 'lease-expired', now);
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
      return claimed;
    });
  }

  claimOne(
    deliveryId: string,
    now: Date,
    leaseMs: number,
  ): Promise<OutboxRecord | null> {
    const nowMs = now.getTime();
    return this.storage.mutate((draft) => {
      const record = draft.outbox[deliveryId];
      if (record === undefined || !this.isClaimable(record, nowMs)) {
        return null;
      }
      record.leaseUntil = new Date(nowMs + leaseMs).toISOString();
      return record;
    });
  }

  recordOutcome(
    deliveryId: string,
    outcome: OutboxOutcome,
    now: Date,
    error?: string,
  ): Promise<OutboxRecord | null> {
    return this.storage.mutate((draft) => {
      const record = draft.outbox[deliveryId];
      if (record === undefined || record.status === 'acked') {
        return null;
      }
      this.applyOutcome(record, outcome, now, error);
      return record;
    });
  }

  /** Returns claimed-but-unsent records to the queue without counting an attempt. */
  releaseLease(deliveryIds: string[], now: Date): Promise<number> {
    return this.storage.mutate((draft) => {
      let released = 0;
      for (const id of deliveryIds) {
        const record = draft.outbox[id];
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
      const record = draft.outbox[deliveryId];
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
      const record = draft.outbox[deliveryId];
      if (record === undefined || record.status !== 'pending') return false;
      record.nextAttemptAt = now.toISOString();
      record.leaseUntil = null;
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
    return state.outbox[deliveryId] ?? null;
  }

  private isClaimable(record: OutboxRecord, nowMs: number): boolean {
    return (
      record.status === 'pending' &&
      record.leaseUntil === null &&
      Date.parse(record.nextAttemptAt) <= nowMs
    );
  }

  private applyOutcome(
    record: OutboxRecord,
    outcome: OutboxOutcome,
    now: Date,
    error?: string,
  ): void {
    const iso = now.toISOString();
    record.attempts += 1;
    record.leaseUntil = null;
    record.nextAttemptAt = new Date(
      now.getTime() + this.backoff.delayMs(record.attempts),
    ).toISOString();
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
    if (record.attempts >= this.cfg.attentionAfterAttempts) {
      record.needsAttention = true;
    }
  }
}

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
