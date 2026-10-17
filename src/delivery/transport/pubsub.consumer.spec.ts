import { EventEmitter } from 'node:events';
import type { Message, PubSub } from '@google-cloud/pubsub';
import { Logger } from '@nestjs/common';
import type { Clock } from '../../common/clock';
import type { OutboxService } from '../outbox.service';
import {
  TransportError,
  type DeliveryPayload,
} from './delivery-transport.port';
import { PubSubConsumer } from './pubsub.consumer';
import type { WebhookTransport } from './webhook.transport';

const NOW = new Date('2026-10-17T10:00:00.000Z');
const clock: Clock = { now: () => NOW };

const payload: DeliveryPayload = {
  deliveryId: 'd1',
  confirmationCode: 'ABC123',
  reservationId: 'R1',
  guest: 'ana@example.com',
  ackToken: 'a'.repeat(64),
  ackUrl: 'http://localhost:3000/deliveries/d1/ack',
};

function fakeMessage(data: string): { message: Message; ack: jest.Mock } {
  const ack = jest.fn();
  const message = {
    id: 'm1',
    data: Buffer.from(data),
    ack,
  } as unknown as Message;
  return { message, ack };
}

function setup(send: jest.Mock) {
  const subscription = Object.assign(new EventEmitter(), {
    close: jest.fn().mockResolvedValue(undefined),
  });
  const pubsub = {
    subscription: jest.fn().mockReturnValue(subscription),
  } as unknown as PubSub;
  const recordOutcome = jest.fn().mockResolvedValue(null);
  const outbox = { recordOutcome } as unknown as OutboxService;
  const webhook = { send } as unknown as WebhookTransport;
  const consumer = new PubSubConsumer(
    pubsub,
    'confirmation-deliveries-sub',
    webhook,
    outbox,
    clock,
    1000,
  );
  return { consumer, subscription, recordOutcome };
}

describe('PubSubConsumer', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('records sent and acks on webhook success', async () => {
    const send = jest.fn().mockResolvedValue('sent');
    const { consumer, recordOutcome } = setup(send);
    const { message, ack } = fakeMessage(JSON.stringify(payload));

    await consumer.handle(message);

    expect(send).toHaveBeenCalledWith(payload);
    expect(recordOutcome).toHaveBeenCalledWith('d1', 'sent', NOW);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('records failed and still acks on webhook failure', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(
        new TransportError('guest device responded 503', 'failed'),
      );
    const { consumer, recordOutcome } = setup(send);
    const { message, ack } = fakeMessage(JSON.stringify(payload));

    await expect(consumer.handle(message)).resolves.toBeUndefined();

    expect(recordOutcome).toHaveBeenCalledWith(
      'd1',
      'failed',
      NOW,
      'guest device responded 503',
    );
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('acks and logs on malformed json without touching the outbox', async () => {
    const send = jest.fn();
    const { consumer, recordOutcome } = setup(send);
    const { message, ack } = fakeMessage('{not json');

    await consumer.handle(message);

    expect(warn).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('onModuleDestroy waits for in-flight handlers', async () => {
    let finishSend!: (v: 'sent') => void;
    const send = jest.fn().mockReturnValue(
      new Promise<'sent'>((resolve) => {
        finishSend = resolve;
      }),
    );
    const { consumer, subscription, recordOutcome } = setup(send);
    consumer.onModuleInit();
    const { message, ack } = fakeMessage(JSON.stringify(payload));
    subscription.emit('message', message);
    expect(send).toHaveBeenCalledTimes(1);

    let destroyed = false;
    const destroying = consumer.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(destroyed).toBe(false);
    expect(subscription.listenerCount('message')).toBe(0);
    expect(subscription.close).not.toHaveBeenCalled();

    finishSend('sent');
    await destroying;

    expect(recordOutcome).toHaveBeenCalledWith('d1', 'sent', NOW);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(subscription.close).toHaveBeenCalledTimes(1);
  });
});
