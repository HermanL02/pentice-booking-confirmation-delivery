import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { readOutbox } from './helpers/ops';
import { waitFor } from './helpers/wait-for';

describe('restart (e2e)', () => {
  let dataDir: string;
  let first: TestApp | undefined;
  let second: TestApp | undefined;

  beforeAll(async () => {
    // Owned by the test, not the helper, so it survives the first app's close().
    dataDir = await mkdtemp(join(tmpdir(), 'bcd-e2e-restart-'));
  });

  afterAll(async () => {
    await first?.close();
    await second?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('a pending delivery is delivered once by the next process on the same data file and port', async () => {
    const dataFile = join(dataDir, 'store.json');
    first = await createTestApp({ DATA_FILE: dataFile });
    const port = new URL(first.baseUrl).port;

    await request(first.baseUrl)
      .put('/guest-device/status')
      .send({ online: false, dropRate: 0 })
      .expect(200);
    const res = await request(first.baseUrl)
      .post('/bookings')
      .send({ reservationId: 'R-restart', guest: 'ana@example.com' })
      .expect(202);
    const deliveryId = res.body.deliveryId as string;
    await waitFor(
      async () => (await readOutbox(dataFile, deliveryId)).attempts >= 1,
      { label: 'attempts >= 1' },
    );
    expect((await readOutbox(dataFile, deliveryId)).status).toBe('pending');

    const closing = first;
    first = undefined;
    await closing.close();

    second = await createTestApp({ DATA_FILE: dataFile, PORT: port });
    expect(second.baseUrl).toBe(closing.baseUrl);

    await waitFor(
      async () => (await readOutbox(dataFile, deliveryId)).status === 'acked',
      { label: 'acked after restart' },
    );
    const inbox = await request(second.baseUrl)
      .get('/guest-device/inbox')
      .expect(200);
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0].deliveryId).toBe(deliveryId);
  });
});
