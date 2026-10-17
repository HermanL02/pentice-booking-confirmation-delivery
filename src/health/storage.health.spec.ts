import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { appConfig } from '../config/app.config';
import { emptyState, STORAGE, type StoragePort } from '../storage/storage.port';
import { StorageHealthIndicator } from './storage.health';

describe('StorageHealthIndicator', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'bcd-health-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const build = async (read: StoragePort['read']) => {
    const store = { read, mutate: jest.fn() } as StoragePort;
    const module = await Test.createTestingModule({
      imports: [TerminusModule],
      providers: [
        StorageHealthIndicator,
        { provide: STORAGE, useValue: store },
        {
          provide: appConfig.KEY,
          useValue: { dataFile: join(dir, 'store.json') },
        },
      ],
    }).compile();
    return module.get(StorageHealthIndicator);
  };

  it('reports up when store reads and dir is writable', async () => {
    const indicator = await build(() => Promise.resolve(emptyState()));

    await expect(indicator.isHealthy()).resolves.toEqual({
      storage: { status: 'up' },
    });
  });

  it('reports down when read rejects', async () => {
    const indicator = await build(() => Promise.reject(new Error('boom')));

    await expect(indicator.isHealthy()).resolves.toEqual({
      storage: { status: 'down', error: 'boom' },
    });
  });
});
