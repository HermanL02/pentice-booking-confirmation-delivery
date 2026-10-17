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

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
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

  const snapshot = { ...process.env };
  Object.assign(process.env, {
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
    restoreEnv(snapshot);
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
        restoreEnv(snapshot);
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}
