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
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new TransportError(e.message, 'timeout');
      }
      throw new TransportError(e.message, 'failed');
    }
    if (!res.ok) {
      throw new TransportError(
        `guest device responded ${res.status}`,
        'failed',
      );
    }
    return 'sent';
  }
}
