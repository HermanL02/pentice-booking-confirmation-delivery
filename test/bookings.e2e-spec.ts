import { readFile } from 'node:fs/promises';
import request from 'supertest';
import {
  STORAGE,
  type StoragePort,
  type StoreState,
} from '@/storage/storage.port';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { OPS_API_KEY } from './helpers/ops';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('bookings (e2e)', () => {
  let t: TestApp;

  const post = (body: object) =>
    request(t.baseUrl).post('/bookings').send(body);

  const readState = async (): Promise<StoreState> =>
    JSON.parse(await readFile(t.dataFile, 'utf8')) as StoreState;

  const codeFor = async (reservationId: string): Promise<string> =>
    (await readState()).reservationIndex[reservationId];

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('POST /bookings returns 202 without a confirmation code in the body', async () => {
    const res = await post({
      reservationId: 'R-202',
      guest: 'ana@example.com',
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      reservationId: 'R-202',
      deliveryId: expect.stringMatching(UUID),
      status: 'pending',
    });
    expect(res.body.confirmationCode).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(await codeFor('R-202'));
  });

  it('GET /:code resolves the booking case-insensitively', async () => {
    await post({ reservationId: 'R-get', guest: 'ana@example.com' }).expect(
      202,
    );
    const code = await codeFor('R-get');

    const res = await request(t.baseUrl).get(`/${code.toUpperCase()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reservationId: 'R-get',
      guest: 'ana@example.com',
      confirmationCode: code,
      createdAt: expect.any(String),
      delivery: {
        status: 'pending',
        attempts: expect.any(Number),
        ackedAt: null,
      },
    });
    expect(res.body.delivery.attempts).toBeGreaterThanOrEqual(0);
  });

  it('GET /:code returns 404 for unknown', async () => {
    await request(t.baseUrl).get('/zzzzz').expect(404);
  });

  it.each([['abcd'], ['abcdef'], ['ab-cd']])(
    'GET /:code returns 400 for %s',
    async (code) => {
      await request(t.baseUrl).get(`/${code}`).expect(400);
    },
  );

  it('GET /health is not swallowed by GET /:code', async () => {
    const res = await request(t.baseUrl).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST with an extra field returns 400', async () => {
    await post({
      reservationId: 'R-extra',
      guest: 'ana@example.com',
      confirmationCode: 'aaaaa',
    }).expect(400);
  });

  it('POST with empty guest returns 400', async () => {
    await post({ reservationId: 'R-empty', guest: '' }).expect(400);
  });

  it('repeat POST same guest returns 200 with the same deliveryId', async () => {
    const dto = { reservationId: 'R-repeat', guest: 'ana@example.com' };
    const first = await post(dto).expect(202);
    const second = await post(dto).expect(200);

    // The repeat reports the delivery's current status, which may already be
    // acked: the device in this app is online.
    expect(second.body).toEqual({
      ...first.body,
      status: expect.stringMatching(/^(pending|acked)$/),
    });
  });

  it('repeat POST different guest returns 409', async () => {
    await post({ reservationId: 'R-409', guest: 'ana@example.com' }).expect(
      202,
    );
    await post({ reservationId: 'R-409', guest: 'bob@example.com' }).expect(
      409,
    );
  });

  it('50 parallel POSTs produce 50 distinct codes', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `R-par-${i}`);
    const responses = await Promise.all(
      ids.map((reservationId) => post({ reservationId, guest: 'g@x.io' })),
    );

    expect(responses.map((r) => r.status)).toEqual(ids.map(() => 202));
    const state = await readState();
    const codes = new Set(ids.map((id) => state.reservationIndex[id]));
    expect(codes.size).toBe(50);
    expect([...codes].every((c) => state.bookings[c] !== undefined)).toBe(true);
  });

  it('2 parallel POSTs with the same reservationId yield one 202 and one 200 with equal deliveryId', async () => {
    const dto = { reservationId: 'R-race', guest: 'ana@example.com' };
    const [a, b] = await Promise.all([post(dto), post(dto)]);

    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body.deliveryId).toBe(b.body.deliveryId);
  });

  it('app.get(STORAGE) resolves the running store', async () => {
    await post({ reservationId: 'R-store', guest: 'ana@example.com' }).expect(
      202,
    );
    const store = t.app.get<StoragePort>(STORAGE);
    const state = await store.read();

    expect(state.version).toBe(1);
    const code = state.reservationIndex['R-store'];
    expect(state.bookings[code]).toMatchObject({
      reservationId: 'R-store',
      guest: 'ana@example.com',
    });
  });

  it.each([['constructor'], ['__proto__'], ['prototype']])(
    'POST with reservationId %s returns 400',
    async (reservationId) => {
      const res = await post({ reservationId, guest: 'ana@example.com' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain(
        'reserved property name',
      );
    },
  );

  it.each([['__proto__'], ['constructor'], ['toString']])(
    'prototype-named deliveryId %s is 404 on the ops and ack routes',
    async (deliveryId) => {
      await request(t.baseUrl)
        .get(`/deliveries/${deliveryId}`)
        .set('x-api-key', OPS_API_KEY)
        .expect(404);
      await request(t.baseUrl)
        .post(`/deliveries/${deliveryId}/retry-now`)
        .set('x-api-key', OPS_API_KEY)
        .expect(404);
      await request(t.baseUrl)
        .post(`/deliveries/${deliveryId}/ack`)
        .send({ ackToken: 'a'.repeat(64) })
        .expect(404);
    },
  );
});
