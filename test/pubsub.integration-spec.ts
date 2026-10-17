import { PubSub } from '@google-cloud/pubsub';
import request from 'supertest';
import { PubSubConsumer } from '@/delivery/transport/pubsub.consumer';
import { PubSubTransport } from '@/delivery/transport/pubsub.transport';
import type { DeliveryPayload } from '@/delivery/transport/delivery-transport.port';
import { setupPubSubEmulator } from '../scripts/setup-pubsub-emulator';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { getDelivery, type DeliveryView } from './helpers/ops';
import { waitFor } from './helpers/wait-for';

const settle = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  // Every publish and every consumed message, by deliveryId. A broker
  // redelivery shows up as a repeated message id and more handled than
  // published messages.
  let publishSpy: jest.SpiedFunction<PubSubTransport['send']>;
  let handleSpy: jest.SpiedFunction<PubSubConsumer['handle']>;
  const publishedFor = (id: string) =>
    publishSpy.mock.calls.filter(([p]) => p.deliveryId === id);
  const handledFor = (id: string) =>
    handleSpy.mock.calls
      .map(([m]) => ({
        messageId: m.id,
        deliveryId: (JSON.parse(m.data.toString()) as DeliveryPayload)
          .deliveryId,
      }))
      .filter((h) => h.deliveryId === id);

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
    // Call-through spies: the real transport and consumer still run.
    publishSpy = jest.spyOn(PubSubTransport.prototype, 'send');
    handleSpy = jest.spyOn(PubSubConsumer.prototype, 'handle');
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
    jest.restoreAllMocks();
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

    // The ack can land before the consumer records 'sent'; the outcome is
    // still counted on the acked record, so wait for both.
    const record = await waitForRecord(
      deliveryId,
      (r) => r.status === 'acked' && r.attempts >= 1,
      `${deliveryId} acked and sent recorded`,
    );

    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe(deliveryId);
    expect(record.attempts).toBe(1);
    expect(record.history.map((h) => h.outcome)).toEqual(['sent']);
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

    await setDevice(true);
    await waitForRecord(
      deliveryId,
      (r) => r.status === 'acked',
      `${deliveryId} acked`,
    );

    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe(deliveryId);

    // Let the last message finish, then give a redelivery time to show up.
    await waitFor(
      () => handledFor(deliveryId).length >= publishedFor(deliveryId).length,
      { label: 'every published message handled' },
    );
    await settle(500);
    const seen = handledFor(deliveryId).map((h) => h.messageId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(publishedFor(deliveryId).length);
    const final = await getDelivery(t.baseUrl, deliveryId);
    // Each handled message records exactly one outcome, including one that
    // lands after the ack.
    expect(final.history).toHaveLength(seen.length);
  });
});
