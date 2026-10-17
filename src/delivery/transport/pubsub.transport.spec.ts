import type { PubSub } from '@google-cloud/pubsub';
import type { DeliveryPayload } from './delivery-transport.port';
import { PubSubTransport } from './pubsub.transport';

const payload: DeliveryPayload = {
  deliveryId: 'd1',
  confirmationCode: 'ABC123',
  reservationId: 'R1',
  guest: 'ana@example.com',
  ackToken: 'a'.repeat(64),
  ackUrl: 'http://localhost:3000/deliveries/d1/ack',
};

function fakePubSub(publishMessage: jest.Mock) {
  const topic = jest.fn().mockReturnValue({ publishMessage });
  return { pubsub: { topic } as unknown as PubSub, topic };
}

describe('PubSubTransport', () => {
  it('publishes the payload as json and resolves handed-off', async () => {
    const publishMessage = jest.fn().mockResolvedValue('msg-1');
    const { pubsub, topic } = fakePubSub(publishMessage);
    const t = new PubSubTransport(pubsub, 'confirmation-deliveries');

    await expect(t.send(payload)).resolves.toBe('handed-off');

    expect(topic).toHaveBeenCalledWith('confirmation-deliveries');
    expect(publishMessage).toHaveBeenCalledTimes(1);
    expect(publishMessage).toHaveBeenCalledWith({ json: payload });
  });
});
