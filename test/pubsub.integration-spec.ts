import { PubSub } from '@google-cloud/pubsub';
import request from 'supertest';
import { setupPubSubEmulator } from '../scripts/setup-pubsub-emulator';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { getDelivery, type DeliveryView } from './helpers/ops';
import { waitFor } from './helpers/wait-for';

// Runs only against a Pub/Sub emulator: PUBSUB_EMULATOR_HOST=localhost:8085.
const d = process.env.PUBSUB_EMULATOR_HOST ? describe : describe.skip;

// The emulator needs no credentials; skip google-auth's GCE metadata probe,
// which otherwise prints a MetadataLookupWarning off GCP.
process.env.METADATA_SERVER_DETECTION ??= 'none';

const PROJECT_ID = 'booking-local';
const TOPIC = 'confirmation-deliveries';
// A subscription of our own, so messages left over from an earlier run never
// reach this run's guest device.
const SUBSCRIPTION = `confirmation-deliveries-it-${process.pid}-${Date.now()}`;

d('pub/sub transport (integration)', () => {
  let t: TestApp;
  let seq = 0;

  const setDevice = (online: boolean) =>
    request(t.baseUrl)
      .put('/guest-device/status')
      .send({ online, dropRate: 0 })
      .expect(200);

  const inbox = async () =>
    (await request(t.baseUrl).get('/guest-device/inbox').expect(200)).body
      .items as { deliveryId: string }[];

  const book = async (): Promise<string> => {
    const res = await request(t.baseUrl)
      .post('/bookings')
      .send({ reservationId: `R-ps-${++seq}`, guest: 'ana@example.com' })
      .expect(202);
    return res.body.deliveryId as string;
  };

  const waitForRecord = async (
    deliveryId: string,
    predicate: (r: DeliveryView) => boolean,
    label: string,
  ): Promise<DeliveryView> => {
    let match: DeliveryView | undefined;
    await waitFor(
      async () => {
        const r = await getDelivery(t.baseUrl, deliveryId);
        if (predicate(r)) match = r;
        return match !== undefined;
      },
      { label, timeoutMs: 10_000 },
    );
    return match as DeliveryView;
  };

  beforeAll(async () => {
    await setupPubSubEmulator({ topic: TOPIC, subscription: SUBSCRIPTION });
    t = await createTestApp({
      PUBSUB_EMULATOR_HOST: process.env.PUBSUB_EMULATOR_HOST as string,
      GCP_PROJECT_ID: PROJECT_ID,
      PUBSUB_TOPIC: TOPIC,
      PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
    });
  });

  afterAll(async () => {
    await t?.close();
    const pubsub = new PubSub({ projectId: PROJECT_ID });
    await pubsub
      .subscription(SUBSCRIPTION)
      .delete()
      .catch(() => undefined);
    await pubsub.close();
  });

  beforeEach(async () => {
    await request(t.baseUrl).delete('/guest-device/inbox').expect(204);
    await setDevice(true);
  });

  it('happy path: delivered through pub/sub, recorded sent, acked once', async () => {
    const deliveryId = await book();

    const record = await waitForRecord(
      deliveryId,
      (r) => r.status === 'acked',
      `${deliveryId} acked`,
    );

    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe(deliveryId);
    // The device acks before its 200 reaches the consumer, so the ack can win
    // the store mutex and make recordOutcome('sent') a no-op: 0 or 1 attempts.
    expect(record.attempts).toBeLessThanOrEqual(1);
    expect(['sent', undefined]).toContain(record.history[0]?.outcome);
  });

  it('offline then online: the outbox retries, the broker never redelivers', async () => {
    await setDevice(false);
    const deliveryId = await book();

    const pending = await waitForRecord(
      deliveryId,
      (r) => r.attempts >= 3,
      'attempts >= 3',
    );
    expect(pending.status).toBe('pending');
    expect(pending.history.map((h) => h.outcome)).toEqual(
      pending.history.map(() => 'failed'),
    );
    // One outbox attempt per history entry, numbered in order: each failure
    // was recorded once and acked, never retried by Pub/Sub itself.
    expect(pending.history.map((h) => h.attempt)).toEqual(
      pending.history.map((_, i) => i + 1),
    );

    await setDevice(true);
    await waitForRecord(
      deliveryId,
      (r) => r.status === 'acked',
      `${deliveryId} acked`,
    );

    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe(deliveryId);
  });
});
