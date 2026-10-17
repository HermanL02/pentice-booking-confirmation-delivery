import type { OutboxRecord } from '../../storage/storage.port';

export interface DeliveryPayload {
  deliveryId: string;
  confirmationCode: string;
  reservationId: string;
  guest: string;
  ackToken: string;
  ackUrl: string;
}

export type SendResult = 'sent' | 'handed-off';

export interface DeliveryTransport {
  send(payload: DeliveryPayload): Promise<SendResult>;
}

export const DELIVERY_TRANSPORT = Symbol('DELIVERY_TRANSPORT');

export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: 'failed' | 'timeout',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransportError';
  }
}

export function toPayload(
  record: OutboxRecord,
  publicBaseUrl: string,
): DeliveryPayload {
  return {
    deliveryId: record.deliveryId,
    confirmationCode: record.confirmationCode,
    reservationId: record.reservationId,
    guest: record.guest,
    ackToken: record.ackToken,
    ackUrl: `${publicBaseUrl.replace(/\/$/, '')}/deliveries/${record.deliveryId}/ack`,
  };
}
