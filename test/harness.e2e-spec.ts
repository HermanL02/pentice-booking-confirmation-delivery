import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigType } from '@nestjs/config';
import { appConfig } from '@/config/app.config';
import { deliveryConfig } from '@/config/delivery.config';
import { createTestApp } from './helpers/create-test-app';

describe('createTestApp harness (e2e)', () => {
  it('a second app in the same file still sees the Joi defaults', async () => {
    for (let i = 0; i < 2; i++) {
      const t = await createTestApp();
      try {
        const delivery = t.app.get<ConfigType<typeof deliveryConfig>>(
          deliveryConfig.KEY,
        );
        const app = t.app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
        expect(Number.isFinite(delivery.shutdownDrainMs)).toBe(true);
        expect(Number.isFinite(delivery.attentionAfterAttempts)).toBe(true);
        expect(Number.isFinite(app.storageLatencyMs)).toBe(true);
      } finally {
        await t.close();
      }
    }
  });

  it('rejects on invalid env, restores it and leaves no temp dir', async () => {
    const before = process.env.DELIVERY_TICK_MS;
    // A private TMPDIR, so the check is not confused by other workers' dirs.
    const scratch = await mkdtemp(join(tmpdir(), 'bcd-harness-'));
    const priorTmp = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      // ConfigModule.forRoot validates once per module registry, so the
      // invalid boot gets a fresh registry of its own.
      await jest.isolateModulesAsync(async () => {
        await expect(
          createTestApp({ DELIVERY_TICK_MS: 'abc' }),
        ).rejects.toThrow(/DELIVERY_TICK_MS/);
      });
      await expect(readdir(scratch)).resolves.toEqual([]);
    } finally {
      if (priorTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = priorTmp;
      await rm(scratch, { recursive: true, force: true });
    }
    expect(process.env.DELIVERY_TICK_MS).toBe(before);
  });
});
