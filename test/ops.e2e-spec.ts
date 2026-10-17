import request from 'supertest';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { getDelivery, listDeliveries, OPS_API_KEY } from './helpers/ops';
import { waitFor } from './helpers/wait-for';

describe('ops (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    // Large backoff: once a send fails, the natural retry is seconds away, so
    // a quick second attempt can only come from retry-now.
    t = await createTestApp({
      DELIVERY_BACKOFF_BASE_MS: '5000',
      DELIVERY_BACKOFF_MAX_MS: '5000',
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
    await waitFor(
      async () => (await getDelivery(t.baseUrl, deliveryId)).attempts >= 1,
      { label: 'attempts >= 1' },
    );
    const { attempts } = await getDelivery(t.baseUrl, deliveryId);

    await request(t.baseUrl)
      .post(`/deliveries/${deliveryId}/retry-now`)
      .set('x-api-key', OPS_API_KEY)
      .expect(200, { scheduled: true });

    await waitFor(
      async () =>
        (await getDelivery(t.baseUrl, deliveryId)).attempts >= attempts + 1,
      { timeoutMs: 1500, label: 'attempt after retry-now' },
    );

    await request(t.baseUrl)
      .post('/deliveries/00000000-0000-4000-8000-000000000000/retry-now')
      .set('x-api-key', OPS_API_KEY)
      .expect(404);
  });
});
