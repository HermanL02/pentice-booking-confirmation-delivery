export interface Booking {
  reservationId: string;
  guest: string;
  confirmationCode: string;
  deliveryId: string;
  createdAt: string;
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
  status: 'pending' | 'acked';
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
