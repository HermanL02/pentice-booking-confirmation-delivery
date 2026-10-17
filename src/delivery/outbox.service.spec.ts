import type { ConfigType } from '@nestjs/config';
import type { deliveryConfig } from '../config/delivery.config';
import {
  emptyState,
  type OutboxRecord,
  type StoragePort,
  type StoreState,
} from '../storage/storage.port';
import { BackoffPolicy } from './backoff.policy';
import { newOutboxRecord } from './outbox.record';
import { OutboxService } from './outbox.service';

class InMemoryStorage implements StoragePort {
  state: StoreState = emptyState();

  read(): Promise<StoreState> {
    return Promise.resolve(structuredClone(this.state));
  }

  async mutate<T>(fn: (draft: StoreState) => T | Promise<T>): Promise<T> {
    const draft = structuredClone(this.state);
    const result = await fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

const NOW = new Date('2026-10-17T12:00:00.000Z');
const LEASE_MS = 30_000;
const BASE_MS = 1_000;
const MAX_MS = 60_000;
const TOKEN = 'a'.repeat(64);
const at = (offsetMs: number): string =>
  new Date(NOW.getTime() + offsetMs).toISOString();

describe('OutboxService', () => {
  let storage: InMemoryStorage;
  let service: OutboxService;

  const seed = (
    deliveryId: string,
    overrides: Partial<OutboxRecord> = {},
  ): void => {
    storage.state.outbox[deliveryId] = {
      ...newOutboxRecord(
        {
          deliveryId,
          confirmationCode: 'abcde',
          reservationId: `R-${deliveryId}`,
          guest: 'ana@example.com',
        },
        NOW,
        TOKEN,
      ),
      ...overrides,
    };
  };

  beforeEach(() => {
    storage = new InMemoryStorage();
    const cfg = { attentionAfterAttempts: 3 } as ConfigType<
      typeof deliveryConfig
    >;
    service = new OutboxService(
      storage,
      new BackoffPolicy(BASE_MS, MAX_MS, () => 1),
      cfg,
    );
  });

  it('claimDue returns due unleased pending records and sets leaseUntil', async () => {
    seed('d1');
    seed('d2', { nextAttemptAt: at(-5_000) });

    const claimed = await service.claimDue(NOW, LEASE_MS);

    expect(claimed.map((r) => r.deliveryId).sort()).toEqual(['d1', 'd2']);
    for (const r of claimed) expect(r.leaseUntil).toBe(at(LEASE_MS));
    expect(storage.state.outbox.d1.leaseUntil).toBe(at(LEASE_MS));
    expect(storage.state.outbox.d2.leaseUntil).toBe(at(LEASE_MS));
  });

  it('claimDue skips records with a live lease', async () => {
    seed('d1', { leaseUntil: at(10_000) });

    await expect(service.claimDue(NOW, LEASE_MS)).resolves.toEqual([]);
    expect(storage.state.outbox.d1.leaseUntil).toBe(at(10_000));
    expect(storage.state.outbox.d1.attempts).toBe(0);
  });

  it('claimDue skips acked records', async () => {
    seed('d1', { status: 'acked', ackedAt: NOW.toISOString() });

    await expect(service.claimDue(NOW, LEASE_MS)).resolves.toEqual([]);
    expect(storage.state.outbox.d1.leaseUntil).toBeNull();
  });

  it('claimDue skips records whose nextAttemptAt is in the future', async () => {
    seed('d1', { nextAttemptAt: at(1) });

    await expect(service.claimDue(NOW, LEASE_MS)).resolves.toEqual([]);
    expect(storage.state.outbox.d1.leaseUntil).toBeNull();
  });

  it('claimDue expires a stale lease as a lease-expired failure before claiming', async () => {
    seed('d1', { leaseUntil: at(-1) });

    const claimed = await service.claimDue(NOW, LEASE_MS);

    expect(claimed).toEqual([]);
    const record = storage.state.outbox.d1;
    expect(record.attempts).toBe(1);
    expect(record.leaseUntil).toBeNull();
    expect(record.nextAttemptAt).toBe(at(BASE_MS));
    expect(record.history).toEqual([
      { at: NOW.toISOString(), attempt: 1, outcome: 'lease-expired' },
    ]);
  });

  it('recordOutcome sent increments attempts, sets lastSentAt, clears lease, schedules next attempt', async () => {
    seed('d1', { leaseUntil: at(LEASE_MS) });

    const updated = await service.recordOutcome('d1', 'sent', NOW);

    expect(updated).toMatchObject({
      attempts: 1,
      lastSentAt: NOW.toISOString(),
      leaseUntil: null,
      nextAttemptAt: at(BASE_MS),
      needsAttention: false,
    });
    expect(updated?.history).toEqual([
      { at: NOW.toISOString(), attempt: 1, outcome: 'sent' },
    ]);
    expect(storage.state.outbox.d1).toEqual(updated);
  });

  it('recordOutcome failed schedules next attempt by backoff', async () => {
    seed('d1', { attempts: 2 });

    const updated = await service.recordOutcome('d1', 'failed', NOW, 'boom');

    expect(updated?.attempts).toBe(3);
    expect(updated?.nextAttemptAt).toBe(at(BASE_MS * 4));
    expect(updated?.lastSentAt).toBeNull();
    expect(updated?.history).toEqual([
      { at: NOW.toISOString(), attempt: 3, outcome: 'failed', error: 'boom' },
    ]);
  });

  it('recordOutcome flags needsAttention at the threshold', async () => {
    seed('d1');

    const first = await service.recordOutcome('d1', 'failed', NOW);
    const second = await service.recordOutcome('d1', 'timeout', NOW);
    expect(first?.needsAttention).toBe(false);
    expect(second?.needsAttention).toBe(false);

    const third = await service.recordOutcome('d1', 'failed', NOW);
    expect(third?.attempts).toBe(3);
    expect(third?.needsAttention).toBe(true);
  });

  it('recordOutcome caps history at 50', async () => {
    seed('d1');

    for (let i = 0; i < 55; i++) {
      await service.recordOutcome('d1', 'failed', NOW);
    }

    const { history, attempts } = storage.state.outbox.d1;
    expect(attempts).toBe(55);
    expect(history).toHaveLength(50);
    expect(history[0].attempt).toBe(6);
    expect(history[49].attempt).toBe(55);
  });

  it('ack with the right token marks acked and clears lease', async () => {
    seed('d1', { leaseUntil: at(LEASE_MS) });

    await expect(service.ack('d1', TOKEN, NOW)).resolves.toBe('acked');
    expect(storage.state.outbox.d1).toMatchObject({
      status: 'acked',
      ackedAt: NOW.toISOString(),
      leaseUntil: null,
    });
  });

  it('ack again returns already-acked', async () => {
    seed('d1');
    await service.ack('d1', TOKEN, NOW);

    await expect(service.ack('d1', TOKEN, new Date(at(5_000)))).resolves.toBe(
      'already-acked',
    );
    expect(storage.state.outbox.d1.ackedAt).toBe(NOW.toISOString());
  });

  it('ack with wrong token returns invalid-token', async () => {
    seed('d1');

    await expect(service.ack('d1', 'b'.repeat(64), NOW)).resolves.toBe(
      'invalid-token',
    );
    await expect(service.ack('d1', 'short', NOW)).resolves.toBe(
      'invalid-token',
    );
    expect(storage.state.outbox.d1.status).toBe('pending');
  });

  it('ack unknown returns not-found', async () => {
    await expect(service.ack('nope', TOKEN, NOW)).resolves.toBe('not-found');
  });

  it('recordOutcome after ack is a no-op', async () => {
    seed('d1');
    await service.ack('d1', TOKEN, NOW);
    const before = structuredClone(storage.state.outbox.d1);

    await expect(
      service.recordOutcome('d1', 'failed', new Date(at(1_000))),
    ).resolves.toBeNull();
    expect(storage.state.outbox.d1).toEqual(before);
  });

  it('retryNow sets nextAttemptAt to now', async () => {
    seed('d1', { nextAttemptAt: at(600_000), leaseUntil: at(LEASE_MS) });

    await expect(service.retryNow('d1', NOW)).resolves.toBe(true);
    expect(storage.state.outbox.d1.nextAttemptAt).toBe(NOW.toISOString());
    expect(storage.state.outbox.d1.leaseUntil).toBeNull();
    await expect(service.retryNow('missing', NOW)).resolves.toBe(false);
  });
});
