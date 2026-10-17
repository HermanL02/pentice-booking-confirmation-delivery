import request from 'supertest';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { getDelivery, readAckToken, type DeliveryView } from './helpers/ops';
import { waitFor } from './helpers/wait-for';

const settle = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls the outbox record until `predicate` holds and returns that record. */
const waitForRecord = async (
  baseUrl: string,
  deliveryId: string,
  predicate: (r: DeliveryView) => boolean,
  label: string,
): Promise<DeliveryView> => {
  let match: DeliveryView | undefined;
  await waitFor(
    async () => {
      const r = await getDelivery(baseUrl, deliveryId);
      if (predicate(r)) match = r;
      return match !== undefined;
    },
    { label },
  );
  return match as DeliveryView;
};

describe('delivery (e2e)', () => {
  let t: TestApp;
  let seq = 0;

  const setDevice = (online: boolean, dropRate = 0) =>
    request(t.baseUrl)
      .put('/guest-device/status')
      .send({ online, dropRate })
      .expect(200);

  const inbox = async () =>
    (await request(t.baseUrl).get('/guest-device/inbox').expect(200)).body
      .items as { deliveryId: string }[];

  const book = async (): Promise<{
    reservationId: string;
    deliveryId: string;
  }> => {
    const reservationId = `R-del-${++seq}`;
    const res = await request(t.baseUrl)
      .post('/bookings')
      .send({ reservationId, guest: 'ana@example.com' })
      .expect(202);
    return { reservationId, deliveryId: res.body.deliveryId as string };
  };

  const outbox = (deliveryId: string) => getDelivery(t.baseUrl, deliveryId);
  const ackTokenOf = (deliveryId: string) =>
    readAckToken(t.dataFile, deliveryId);

  const ack = (deliveryId: string, ackToken: string) =>
    request(t.baseUrl).post(`/deliveries/${deliveryId}/ack`).send({ ackToken });

  const waitForAcked = (deliveryId: string) =>
    waitFor(async () => (await outbox(deliveryId)).status === 'acked', {
      label: `${deliveryId} acked`,
    });

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await request(t.baseUrl).delete('/guest-device/inbox').expect(204);
    await setDevice(true, 0);
  });

  it('happy path: booking is delivered, acked once, GET /:code shows acked', async () => {
    const { deliveryId } = await book();

    await waitForAcked(deliveryId);

    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe(deliveryId);
    const record = await outbox(deliveryId);
    expect(record.status).toBe('acked');
    // The device acks before its 200 is flushed, so the ack can win the store
    // mutex and make the dispatcher's recordOutcome('sent') a no-op: 0 or 1.
    expect(record.attempts).toBeLessThanOrEqual(1);
    expect(record.history.length).toBeLessThanOrEqual(1);

    const res = await request(t.baseUrl)
      .get(`/${record.confirmationCode}`)
      .expect(200);
    expect(res.body.delivery).toMatchObject({
      status: 'acked',
      ackedAt: expect.any(String),
    });
    expect(res.body.delivery.attempts).toBeLessThanOrEqual(1);
  });

  it('offline then online: retries with backoff until acked, device receives exactly one', async () => {
    await setDevice(false);
    const { deliveryId } = await book();

    const pending = await waitForRecord(
      t.baseUrl,
      deliveryId,
      (r) => r.attempts >= 3,
      'attempts >= 3',
    );
    expect(pending.status).toBe('pending');
    expect(pending.history.map((h) => h.outcome)).toEqual(
      pending.history.map(() => 'failed'),
    );

    await setDevice(true);
    await waitForAcked(deliveryId);

    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe(deliveryId);
  });

  it('drop rate 1 then 0: sent-but-lost is retried', async () => {
    await setDevice(true, 1);
    const { deliveryId } = await book();

    const pending = await waitForRecord(
      t.baseUrl,
      deliveryId,
      (r) => r.history.filter((h) => h.outcome === 'sent').length >= 2,
      'two sent attempts',
    );
    expect(pending.status).toBe('pending');
    expect(await inbox()).toHaveLength(0);

    await setDevice(true, 0);
    await waitForAcked(deliveryId);

    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe(deliveryId);
  });

  it('ack with wrong token is 401 and record stays pending', async () => {
    await setDevice(false);
    const { deliveryId } = await book();
    const ackToken = await ackTokenOf(deliveryId);

    // Same length as a real token (64 chars) so it passes validation and is
    // rejected by the token comparison, not the DTO.
    const wrong = `${ackToken.slice(0, -1)}${ackToken.endsWith('0') ? '1' : '0'}`;
    await ack(deliveryId, wrong).expect(401);
    await ack(deliveryId, 'f'.repeat(64)).expect(401);

    const record = await outbox(deliveryId);
    expect(record.status).toBe('pending');
    expect(record.ackedAt).toBeNull();

    // Leave nothing pending for the scenarios that follow.
    await ack(deliveryId, ackToken).expect(200);
  });

  it('ack twice is 200 then 200 already-acked', async () => {
    await setDevice(false);
    const { deliveryId } = await book();
    const ackToken = await ackTokenOf(deliveryId);

    const first = await ack(deliveryId, ackToken).expect(200);
    const second = await ack(deliveryId, ackToken).expect(200);

    expect(first.body).toEqual({ status: 'acked' });
    expect(second.body).toEqual({ status: 'already-acked' });
    expect((await outbox(deliveryId)).status).toBe('acked');
  });

  it('ack for an unknown delivery is 404', async () => {
    await ack('00000000-0000-4000-8000-000000000000', 'a'.repeat(64)).expect(
      404,
    );
  });

  it('late ack after retry in flight does not duplicate', async () => {
    await setDevice(false);
    const { deliveryId } = await book();
    await waitFor(async () => (await outbox(deliveryId)).attempts >= 1, {
      label: 'attempts >= 1',
    });
    const ackToken = await ackTokenOf(deliveryId);

    await ack(deliveryId, ackToken).expect(200, { status: 'acked' });
    const attemptsAtAck = (await outbox(deliveryId)).attempts;
    await setDevice(true);

    await waitForAcked(deliveryId);
    await settle(300);
    expect((await inbox()).length).toBeLessThanOrEqual(1);

    const before = await outbox(deliveryId);
    await settle(200);
    const after = await outbox(deliveryId);
    expect(after.status).toBe('acked');
    expect(before.attempts).toBe(attemptsAtAck);
    expect(after.attempts).toBe(before.attempts);
  });
});

describe('delivery to an unreachable device (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      GUEST_DEVICE_INBOX_URL: 'http://127.0.0.1:1/inbox',
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it('connection refused is a failed attempt', async () => {
    const res = await request(t.baseUrl)
      .post('/bookings')
      .send({ reservationId: 'R-refused', guest: 'ana@example.com' })
      .expect(202);
    const deliveryId = res.body.deliveryId as string;

    const record = await waitForRecord(
      t.baseUrl,
      deliveryId,
      (r) => r.attempts >= 2,
      'attempts >= 2',
    );
    expect(record.status).toBe('pending');
    expect(record.history.map((h) => h.outcome)).toEqual(
      record.history.map(() => 'failed'),
    );

    const health = await request(t.baseUrl).get('/health');
    expect(health.status).toBe(200);
  });
});
