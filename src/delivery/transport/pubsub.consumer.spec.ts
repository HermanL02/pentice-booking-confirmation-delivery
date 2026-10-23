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
  kind: 'confirmation',
  confirmationCode: 'ABC123',
  reservationId: 'R1',
  guest: 'ana@example.com',
  ackToken: 'a'.repeat(64),
  ackUrl: 'http://localhost:3000/deliveries/d1/ack',
};

interface FakeMessage {
  message: Message;
  ack: jest.Mock;
  nack: jest.Mock;
}

function fakeMessage(data: string): FakeMessage {
  const ack = jest.fn();
  const nack = jest.fn();
  const message = {
    id: 'm1',
    data: Buffer.from(data),
    ack,
    nack,
  } as unknown as Message;
  return { message, ack, nack };
}

/**
 * Mimics @google-cloud/pubsub's Subscription: removing the last 'message'
 * listener, or closing with the default NACK behaviour, nacks every message
 * not yet acked.
 */
function fakeSubscription() {
  const outstanding = new Set<FakeMessage>();
  const nackOutstanding = () => {
    for (const m of outstanding) m.nack();
    outstanding.clear();
  };
  const state: { options: unknown } = { options: undefined };
  const subscription = Object.assign(new EventEmitter(), state, {
    close: jest.fn(() => {
      const behavior = (
        subscription.options as { closeOptions?: { behavior?: string } }
      )?.closeOptions?.behavior;
      if (behavior !== 'WAIT') nackOutstanding();
      return Promise.resolve();
    }),
    deliver(m: FakeMessage) {
      outstanding.add(m);
      m.ack.mockImplementation(() => outstanding.delete(m));
      subscription.emit('message', m.message);
    },
  });
  subscription.on('removeListener', (event: string) => {
    if (event === 'message' && subscription.listenerCount('message') === 0) {
      nackOutstanding();
    }
  });
  return subscription;
}

function setup(send: jest.Mock) {
  const subscription = fakeSubscription();
  const pubsub = {
    subscription: jest.fn((_name: string, options: unknown) => {
      subscription.options = options;
      return subscription;
    }),
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
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
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
    const m = fakeMessage(JSON.stringify(payload));
    subscription.deliver(m);
    expect(send).toHaveBeenCalledTimes(1);

    let destroyed = false;
    const destroying = consumer.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(destroyed).toBe(false);
    expect(subscription.close).not.toHaveBeenCalled();

    finishSend('sent');
    await destroying;

    expect(recordOutcome).toHaveBeenCalledWith('d1', 'sent', NOW);
    expect(subscription.close).toHaveBeenCalledTimes(1);
    expect(m.ack.mock.invocationCallOrder[0]).toBeLessThan(
      subscription.close.mock.invocationCallOrder[0],
    );
    expect(m.nack).not.toHaveBeenCalled();
  });

  it('in-flight messages are acked, never nacked, across shutdown', async () => {
    const pending: ((v: 'sent') => void)[] = [];
    const send = jest.fn(
      () => new Promise<'sent'>((resolve) => pending.push(resolve)),
    );
    const { consumer, subscription } = setup(send);
    consumer.onModuleInit();
    const first = fakeMessage(JSON.stringify(payload));
    subscription.deliver(first);

    const destroying = consumer.onModuleDestroy();
    // Arrives during the drain: still handled, not dropped or nacked.
    const second = fakeMessage(
      JSON.stringify({ ...payload, deliveryId: 'd2' }),
    );
    subscription.deliver(second);
    await new Promise((r) => setImmediate(r));
    for (const resolve of pending) resolve('sent');
    await new Promise((r) => setImmediate(r));
    for (const resolve of pending) resolve('sent');
    await destroying;

    for (const m of [first, second]) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.nack).not.toHaveBeenCalled();
    }
    expect(subscription.options).toMatchObject({
      closeOptions: { behavior: 'WAIT' },
    });
    expect(subscription.listenerCount('message')).toBe(0);
  });

  it('a failing subscription.close is logged and does not reject', async () => {
    const { consumer, subscription } = setup(jest.fn());
    consumer.onModuleInit();
    subscription.close.mockRejectedValueOnce(new Error('boom'));

    await expect(consumer.onModuleDestroy()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    expect(subscription.listenerCount('error')).toBe(0);
  });
});
