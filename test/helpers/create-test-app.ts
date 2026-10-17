import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  dataFile: string;
  close(): Promise<void>;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Sets `overrides` on process.env and returns a function that undoes exactly
 * those keys: prior values come back, keys that were absent are deleted.
 * Nothing else is touched, so the defaults ConfigModule.forRoot writes into
 * process.env on the first import survive for later apps in the same file.
 */
function applyEnv(overrides: Record<string, string>): () => void {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function createTestApp(
  env: Record<string, string> = {},
): Promise<TestApp> {
  // PORT and DATA_FILE overrides let a test boot a second app on the same
  // port and data file (restart scenarios). A caller-supplied DATA_FILE is the
  // caller's to clean up; close() only removes the helper's own temp dir.
  const port = env.PORT === undefined ? await getFreePort() : Number(env.PORT);
  const dataDir = await mkdtemp(join(tmpdir(), 'bcd-e2e-'));
  const dataFile = env.DATA_FILE ?? join(dataDir, 'store.json');
  const baseUrl = `http://127.0.0.1:${port}`;

  const restoreEnv = applyEnv({
    NODE_ENV: 'test',
    OPS_API_KEY: 'test',
    DATA_FILE: dataFile,
    PORT: String(port),
    PUBLIC_BASE_URL: baseUrl,
    GUEST_DEVICE_INBOX_URL: `${baseUrl}/guest-device/inbox`,
    DELIVERY_TICK_MS: '50',
    DELIVERY_BACKOFF_BASE_MS: '20',
    DELIVERY_BACKOFF_MAX_MS: '200',
    DELIVERY_LEASE_MS: '500',
    DELIVERY_TIMEOUT_MS: '500',
    LOG_LEVEL: 'silent',
    THROTTLE_LIMIT_PER_MINUTE: '1000',
    ...env,
  });

  let app: INestApplication;
  try {
    // Order matters: ConfigModule.forRoot validates the env once, when AppModule
    // is first imported, so the env must be set before this import. The
    // registerAs namespace factories re-read process.env at each app's init, so
    // later calls with different env values still take effect.
    const { createApp } = await import('@/main');
    app = await createApp();
    await app.listen(port, '127.0.0.1');
  } catch (err) {
    restoreEnv();
    await rm(dataDir, { recursive: true, force: true });
    throw err;
  }

  return {
    app,
    baseUrl,
    dataFile,
    async close() {
      try {
        await app.close();
      } finally {
        restoreEnv();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}
