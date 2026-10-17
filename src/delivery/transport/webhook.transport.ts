import {
  TransportError,
  type DeliveryPayload,
  type DeliveryTransport,
  type SendResult,
} from './delivery-transport.port';

export class WebhookTransport implements DeliveryTransport {
  constructor(
    private readonly inboxUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async send(payload: DeliveryPayload): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.fetchFn(this.inboxUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut =
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new TransportError(message, timedOut ? 'timeout' : 'failed', {
        cause: err,
      });
    }
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) {
      throw new TransportError(
        `guest device responded ${res.status}`,
        'failed',
      );
    }
    return 'sent';
  }
}
