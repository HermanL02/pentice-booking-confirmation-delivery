/**
 * Offline-then-online walkthrough against a running server:
 *   BASE_URL=http://localhost:3000 OPS_API_KEY=... pnpm demo
 */
import { randomUUID } from 'node:crypto';

interface Delivery {
  deliveryId: string;
  confirmationCode: string;
  status: 'pending' | 'acked';
  attempts: number;
  nextAttemptAt: string;
  ackedAt: string | null;
  history: { outcome: string; error?: string }[];
}

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const OPS_API_KEY = process.env.OPS_API_KEY;
const ACK_TIMEOUT_MS = 30_000;

let step = 0;
const say = (line: string): void => console.log(`${++step}. ${line}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': OPS_API_KEY ?? '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const setDevice = (online: boolean) =>
  call('PUT', '/guest-device/status', { online, dropRate: 0 });
const getDelivery = (id: string) => call<Delivery>('GET', `/deliveries/${id}`);

async function main(): Promise<void> {
  if (!OPS_API_KEY) {
    console.error("OPS_API_KEY is required (the server's OPS_API_KEY).");
    process.exit(1);
  }

  await setDevice(false);
  say('Guest device set offline: the inbox now answers 503.');

  const reservationId = `R-demo-${randomUUID().slice(0, 8)}`;
  const booking = await call<{ deliveryId: string }>('POST', '/bookings', {
    reservationId,
    guest: 'guest@example.com',
  });
  const { deliveryId } = booking;
  say(`POST /bookings ${reservationId} -> 202, deliveryId=${deliveryId}`);

  for (let i = 0; i < 3; i++) {
    await sleep(1_200);
    const d = await getDelivery(deliveryId);
    const last = d.history.at(-1);
    say(
      `GET /deliveries/${deliveryId}: status=${d.status} attempts=${d.attempts} ` +
        `nextAttemptAt=${d.nextAttemptAt} last=${last ? `${last.outcome}${last.error ? ` (${last.error})` : ''}` : '-'}`,
    );
  }

  await setDevice(true);
  say('Guest device set online.');

  const deadline = Date.now() + ACK_TIMEOUT_MS;
  let d = await getDelivery(deliveryId);
  while (d.status !== 'acked') {
    if (Date.now() > deadline) {
      throw new Error(`not acked within ${ACK_TIMEOUT_MS} ms`);
    }
    await sleep(250);
    d = await getDelivery(deliveryId);
  }
  say(`Delivery acked at ${d.ackedAt} after ${d.attempts} attempt(s).`);

  const view = await call<unknown>('GET', `/${d.confirmationCode}`);
  say(`GET /${d.confirmationCode} -> ${JSON.stringify(view)}`);
}

main().catch((err: unknown) => {
  console.error(
    `demo failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
