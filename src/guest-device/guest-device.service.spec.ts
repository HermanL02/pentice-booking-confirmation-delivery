import { Logger } from '@nestjs/common';
import { InboxMessageDto } from './dto/inbox-message.dto';
import { GuestDeviceService } from './guest-device.service';

const msg = (deliveryId = 'd1'): InboxMessageDto => ({
  deliveryId,
  confirmationCode: 'ABC123',
  reservationId: 'r1',
  guest: 'Ada',
  ackToken: 't',
  ackUrl: 'http://localhost:3000/deliveries/d1/ack',
});

describe('GuestDeviceService', () => {
  const build = (random = () => 0.5) =>
    new GuestDeviceService(jest.fn(), random);

  it('offline returns offline and stores nothing', () => {
    const svc = build();
    svc.setStatus({ online: false, dropRate: 0 });
    expect(svc.receive(msg())).toBe('offline');
    expect(svc.inbox()).toEqual([]);
  });

  it('dropRate 1 returns dropped and stores nothing', () => {
    const svc = build();
    svc.setStatus({ online: true, dropRate: 1 });
    expect(svc.receive(msg())).toBe('dropped');
    expect(svc.inbox()).toEqual([]);
  });

  it('first receive stores and returns received', () => {
    const svc = build();
    expect(svc.receive(msg())).toBe('received');
    expect(svc.inbox()).toHaveLength(1);
    expect(svc.inbox()[0]).toMatchObject({
      deliveryId: 'd1',
      confirmationCode: 'ABC123',
      reservationId: 'r1',
    });
  });

  it('second receive same deliveryId returns duplicate and inbox has one item', () => {
    const svc = build();
    svc.receive(msg());
    expect(svc.receive(msg())).toBe('duplicate');
    expect(svc.inbox()).toHaveLength(1);
  });

  it('acknowledge retries 3 times then gives up', async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const fetchFn = jest.fn().mockRejectedValue(new Error('down'));
      const svc = new GuestDeviceService(fetchFn, () => 0.5);
      const p = svc.acknowledge('http://x/ack', 'tok');
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(100);
      await expect(p).resolves.toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});
