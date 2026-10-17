import type { OutboxRecord } from '../storage/storage.port';
import { MetricsService } from './metrics.service';
import { newOutboxRecord } from './outbox.record';
import type { OutboxService } from './outbox.service';

const CREATED = new Date('2026-10-17T12:00:00.000Z');
const after = (ms: number): string =>
  new Date(CREATED.getTime() + ms).toISOString();

const rec = (
  deliveryId: string,
  overrides: Partial<OutboxRecord> = {},
): OutboxRecord => ({
  ...newOutboxRecord(
    {
      deliveryId,
      confirmationCode: 'abcde',
      reservationId: `R-${deliveryId}`,
      guest: 'ana@example.com',
    },
    CREATED,
    'a'.repeat(64),
  ),
  ...overrides,
});

const acked = (deliveryId: string, ackAfterMs: number, attempts = 1) =>
  rec(deliveryId, { status: 'acked', ackedAt: after(ackAfterMs), attempts });

describe('MetricsService', () => {
  const build = (records: OutboxRecord[]) =>
    new MetricsService({
      list: jest.fn().mockResolvedValue(records),
    } as unknown as OutboxService);

  it('counts pending and acked', async () => {
    const metrics = build([
      rec('p1', { attempts: 3 }),
      rec('p2', { attempts: 12, needsAttention: true }),
      acked('a1', 100),
    ]);

    await expect(metrics.snapshot()).resolves.toMatchObject({
      pending: 2,
      acked: 1,
      needsAttention: 1,
    });
  });

  it('buckets attempts', async () => {
    const metrics = build([
      rec('zero'),
      rec('one', { attempts: 1 }),
      acked('two', 10, 2),
      rec('three', { attempts: 3 }),
      rec('four', { attempts: 4 }),
      rec('ten', { attempts: 10 }),
      rec('eleven', { attempts: 11 }),
      rec('many', { attempts: 99 }),
    ]);

    expect((await metrics.snapshot()).attemptsHistogram).toEqual({
      '1': 1,
      '2-3': 2,
      '4-10': 2,
      '11+': 2,
    });
  });

  it('computes time-to-ack percentiles from createdAt→ackedAt', async () => {
    const metrics = build([
      acked('a3', 300),
      acked('a1', 100),
      acked('a5', 5_000),
      acked('a2', 200),
      acked('a4', 400),
      rec('pending'),
    ]);

    expect((await metrics.snapshot()).timeToAckMs).toEqual({
      p50: 300,
      p95: 5_000,
      p99: 5_000,
    });
  });

  it('null percentiles when nothing acked', async () => {
    const metrics = build([rec('p1', { attempts: 2 })]);

    expect((await metrics.snapshot()).timeToAckMs).toEqual({
      p50: null,
      p95: null,
      p99: null,
    });
  });

  it('reports its own tick and transport failure counters', async () => {
    const metrics = build([]);
    const t1 = new Date('2026-10-17T12:00:01.000Z');
    const t2 = new Date('2026-10-17T12:00:02.000Z');

    expect(await metrics.snapshot()).toMatchObject({
      ticks: 0,
      transportFailures: 0,
      lastTickAt: null,
    });
    metrics.recordTick(t1);
    metrics.recordTick(t2);
    metrics.incrementTransportFailures();

    expect(await metrics.snapshot()).toMatchObject({
      ticks: 2,
      transportFailures: 1,
      lastTickAt: t2.toISOString(),
    });
  });
});
