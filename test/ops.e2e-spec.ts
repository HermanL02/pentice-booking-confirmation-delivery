import request from 'supertest';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import {
  getDelivery,
  listDeliveries,
  OPS_API_KEY,
  type DeliveryView,
} from './helpers/ops';
import { waitFor } from './helpers/wait-for';

/** How far ahead the natural retry must be when retry-now is called. */
const MIN_LEAD_MS = 2500;

describe('ops (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    // Large backoff: with full jitter the natural retry lands uniformly in
    // [0, 20 s), so it is rarely within the retry-now test's minimum lead.
    t = await createTestApp({
      DELIVERY_BACKOFF_BASE_MS: '20000',
      DELIVERY_BACKOFF_MAX_MS: '20000',
    });
    await request(t.baseUrl)
      .put('/guest-device/status')
      .send({ online: false, dropRate: 0 })
      .expect(200);
  });

  afterAll(async () => {
    await t.close();
  });

  const book = async (reservationId: string): Promise<string> => {
    const res = await request(t.baseUrl)
      .post('/bookings')
      .send({ reservationId, guest: 'ana@example.com' })
      .expect(202);
    return res.body.deliveryId as string;
  };

  it('GET /deliveries without key is 401', async () => {
    await request(t.baseUrl).get('/deliveries').expect(401);
    await request(t.baseUrl)
      .get('/deliveries')
      .set('x-api-key', 'wrong')
      .expect(401);
    await request(t.baseUrl)
      .get('/deliveries/00000000-0000-4000-8000-000000000000')
      .expect(401);
    await request(t.baseUrl)
      .post('/deliveries/00000000-0000-4000-8000-000000000000/retry-now')
      .expect(401);
  });

  it('with key lists the pending record', async () => {
    const deliveryId = await book('R-ops-list');

    const pending = await listDeliveries(t.baseUrl, { status: 'pending' });
    const record = pending.find((r) => r.deliveryId === deliveryId);
    expect(record).toMatchObject({ deliveryId, status: 'pending' });
    expect(record).not.toHaveProperty('ackToken');
    expect(await listDeliveries(t.baseUrl, { status: 'acked' })).toEqual([]);

    const one = await getDelivery(t.baseUrl, deliveryId);
    expect(one).toMatchObject({ deliveryId, reservationId: 'R-ops-list' });
    expect(one).not.toHaveProperty('ackToken');

    await request(t.baseUrl)
      .get('/deliveries/00000000-0000-4000-8000-000000000000')
      .set('x-api-key', OPS_API_KEY)
      .expect(404);
    await request(t.baseUrl)
      .get('/deliveries?status=bogus')
      .set('x-api-key', OPS_API_KEY)
      .expect(400);
  });

  it('retry-now makes the next tick send immediately', async () => {
    const deliveryId = await book('R-ops-retry');
    const read = () => getDelivery(t.baseUrl, deliveryId);
    await waitFor(async () => (await read()).attempts >= 1, {
      label: 'attempts >= 1',
    });

    // Make the natural retry provably distinct from retry-now: while the
    // scheduled attempt is too close, let it happen and look again.
    let before = await read();
    while (Date.parse(before.nextAttemptAt) - Date.now() < MIN_LEAD_MS) {
      const seen = before.attempts;
      await waitFor(async () => (await read()).attempts > seen, {
        timeoutMs: MIN_LEAD_MS + 1000,
        label: 'next natural attempt',
      });
      before = await read();
    }
    const scheduledAt = Date.parse(before.nextAttemptAt);

    await request(t.baseUrl)
      .post(`/deliveries/${deliveryId}/retry-now`)
      .set('x-api-key', OPS_API_KEY)
      .expect(200, { scheduled: true });

    // A natural retry cannot run before nextAttemptAt, so an attempt recorded
    // earlier than the captured schedule can only have come from retry-now.
    let after: DeliveryView | undefined;
    await waitFor(
      async () => {
        const r = await read();
        const early = r.history.some(
          (h) => h.attempt > before.attempts && Date.parse(h.at) < scheduledAt,
        );
        if (early) after = r;
        return early;
      },
      { timeoutMs: 1500, label: 'attempt before the scheduled time' },
    );
    expect(after?.attempts).toBeGreaterThan(before.attempts);

    await request(t.baseUrl)
      .post('/deliveries/00000000-0000-4000-8000-000000000000/retry-now')
      .set('x-api-key', OPS_API_KEY)
      .expect(404);
  }, 10_000);

  it('GET /metrics requires the key and returns a snapshot', async () => {
    await request(t.baseUrl).get('/metrics').expect(401);

    const res = await request(t.baseUrl)
      .get('/metrics')
      .set('x-api-key', OPS_API_KEY)
      .expect(200);

    expect(res.body).toMatchObject({
      pending: expect.any(Number),
      acked: expect.any(Number),
      needsAttention: expect.any(Number),
      attemptsHistogram: { '1': expect.any(Number) },
      timeToAckMs: { p50: null, p95: null, p99: null },
      ticks: expect.any(Number),
      transportFailures: expect.any(Number),
      lastTickAt: expect.any(String),
    });
    expect(res.body.ticks).toBeGreaterThan(0);
    expect(res.body.transportFailures).toBeGreaterThan(0);
  });
});
