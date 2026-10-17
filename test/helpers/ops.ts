import { readFile } from 'node:fs/promises';
import type { OutboxRecord, StoreState } from '@/storage/storage.port';

// Reads the data file directly for now; the ops API replaces these reads in a
// later PR.

export async function readState(dataFile: string): Promise<StoreState> {
  return JSON.parse(await readFile(dataFile, 'utf8')) as StoreState;
}

export async function readOutbox(
  dataFile: string,
  deliveryId: string,
): Promise<OutboxRecord> {
  const record = (await readState(dataFile)).outbox[deliveryId];
  if (record === undefined) {
    throw new Error(`outbox record not found: ${deliveryId}`);
  }
  return record;
}
