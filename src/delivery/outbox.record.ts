import { randomBytes } from 'node:crypto';
import type { OutboxRecord } from '../storage/storage.port';

export interface NewOutboxRecordInput {
  deliveryId: string;
  confirmationCode: string;
  reservationId: string;
  guest: string;
}

export function newOutboxRecord(
  input: NewOutboxRecordInput,
  now: Date,
  ackToken: string = randomBytes(32).toString('hex'),
): OutboxRecord {
  const iso = now.toISOString();
  return {
    deliveryId: input.deliveryId,
    confirmationCode: input.confirmationCode,
    reservationId: input.reservationId,
    guest: input.guest,
    ackToken,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: iso,
    leaseUntil: null,
    lastSentAt: null,
    ackedAt: null,
    needsAttention: false,
    createdAt: iso,
    history: [],
  };
}
