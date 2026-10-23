import {
  TransportError,
  type DeliveryPayload,
} from './delivery-transport.port';
import { WebhookTransport } from './webhook.transport';

const payload: DeliveryPayload = {
  deliveryId: 'd1',
  kind: 'confirmation',
  confirmationCode: 'ABC123',
  reservationId: 'R1',
  guest: 'ana@example.com',
  ackToken: 'a'.repeat(64),
  ackUrl: 'http://localhost:3000/deliveries/d1/ack',
};
const URL_ = 'http://device.test/inbox';

function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('WebhookTransport', () => {
  it('resolves sent on 200', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const t = new WebhookTransport(URL_, 1000, fetchFn);
    await expect(t.send(payload)).resolves.toBe('sent');
  });

  it('rejects TransportError failed on 503', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const t = new WebhookTransport(URL_, 1000, fetchFn);
    const err = await t.send(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('failed');
  });

  it.each(['AbortError', 'TimeoutError'])(
    'rejects TransportError timeout when fetch rejects with %s',
    async (name) => {
      const fetchFn = jest.fn().mockRejectedValue(named(name));
      const t = new WebhookTransport(URL_, 1000, fetchFn);
      const err = await t.send(payload).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('timeout');
    },
  );

  it('rejects TransportError failed on connection refused', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const t = new WebhookTransport(URL_, 1000, fetchFn);
    const err = await t.send(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('failed');
  });

  it('posts the payload as JSON to the inbox url', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const t = new WebhookTransport(URL_, 1000, fetchFn);
    await t.send(payload);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('rejects TransportError failed when fetch rejects with a non-Error value', async () => {
    const fetchFn = jest.fn().mockRejectedValue(null);
    const t = new WebhookTransport(URL_, 1000, fetchFn);
    const err = await t.send(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('failed');
  });

  it('preserves the original error as cause', async () => {
    const cause = new TypeError('fetch failed');
    const fetchFn = jest.fn().mockRejectedValue(cause);
    const t = new WebhookTransport(URL_, 1000, fetchFn);
    const err = await t.send(payload).catch((e: unknown) => e);
    expect((err as TransportError).cause).toBe(cause);
  });

  it('drains the response body on non-2xx', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const fetchFn = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, body: { cancel } });
    const t = new WebhookTransport(URL_, 1000, fetchFn);
    await t.send(payload).catch(() => undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
