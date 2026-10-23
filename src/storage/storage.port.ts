export interface Booking {
  reservationId: string;
  guest: string;
  confirmationCode: string;
  deliveryId: string;
  createdAt: string;
  cancelledAt?: string;
  /** The outbox record that tells the guest about the cancellation. */
  cancellationDeliveryId?: string;
}

export type OutboxOutcome = 'sent' | 'failed' | 'timeout' | 'lease-expired';

export interface OutboxHistoryEntry {
  at: string;
  attempt: number;
  outcome: OutboxOutcome;
  error?: string;
}

export interface OutboxRecord {
  deliveryId: string;
  confirmationCode: string;
  reservationId: string;
  guest: string;
  ackToken: string;
  status: 'pending' | 'acked' | 'cancelled';
  kind: 'confirmation' | 'cancellation';
  /** Not claimable while this record holds a live lease (its send is in flight). */
  waitsFor: string | null;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  lastSentAt: string | null;
  ackedAt: string | null;
  needsAttention: boolean;
  createdAt: string;
  history: OutboxHistoryEntry[];
}

export interface StoreState {
  version: 1;
  bookings: Record<string, Booking>;
  reservationIndex: Record<string, string>;
  outbox: Record<string, OutboxRecord>;
}

export const emptyState = (): StoreState => ({
  version: 1,
  bookings: {},
  reservationIndex: {},
  outbox: {},
});

export interface StoragePort {
  /** Returns a deep clone of the current state. */
  read(): Promise<StoreState>;
  /** Serialised; the draft is persisted atomically after `fn` returns. */
  mutate<T>(fn: (draft: StoreState) => T | Promise<T>): Promise<T>;
}

export const STORAGE = Symbol('STORAGE');

/**
 * Own-property read for the keyed maps in `StoreState`. A plain index would
 * return inherited members for ids like `constructor` or `__proto__`.
 */
export const own = <T>(rec: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(rec, key) ? rec[key] : undefined;
