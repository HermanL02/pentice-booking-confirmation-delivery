import { readFile } from 'node:fs/promises';
import request from 'supertest';
import type { OutboxRecord, StoreState } from '@/storage/storage.port';

/** The OPS_API_KEY createTestApp sets. */
export const OPS_API_KEY = 'test';

/** An outbox record as the ops API returns it: never with its ackToken. */
export type DeliveryView = Omit<OutboxRecord, 'ackToken'>;

export async function getDelivery(
  baseUrl: string,
  deliveryId: string,
): Promise<DeliveryView> {
  const res = await request(baseUrl)
    .get(`/deliveries/${deliveryId}`)
    .set('x-api-key', OPS_API_KEY);
  if (res.status !== 200) {
    throw new Error(`GET /deliveries/${deliveryId} returned ${res.status}`);
  }
  return res.body as DeliveryView;
}

export async function listDeliveries(
  baseUrl: string,
  filter: { status?: OutboxRecord['status']; attention?: boolean } = {},
): Promise<DeliveryView[]> {
  const res = await request(baseUrl)
    .get('/deliveries')
    .query(filter)
    .set('x-api-key', OPS_API_KEY)
    .expect(200);
  return res.body as DeliveryView[];
}

// The ops API deliberately never exposes the ackToken (it is the guest
// device's credential), so tests that need it read the data file.

async function readState(dataFile: string): Promise<StoreState> {
  return JSON.parse(await readFile(dataFile, 'utf8')) as StoreState;
}

export async function readAckToken(
  dataFile: string,
  deliveryId: string,
): Promise<string> {
  const record = (await readState(dataFile)).outbox[deliveryId];
  if (record === undefined) {
    throw new Error(`outbox record not found: ${deliveryId}`);
  }
  return record.ackToken;
}
