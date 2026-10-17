import { NotFoundException } from '@nestjs/common';
import type { Clock } from '../common/clock';
import { newOutboxRecord } from './outbox.record';
import type { OutboxService } from './outbox.service';
import { OpsController } from './ops.controller';

describe('OpsController', () => {
  const now = new Date('2026-10-17T12:00:00.000Z');
  const clock: Clock = { now: () => now };
  const outbox = { list: jest.fn(), get: jest.fn(), retryNow: jest.fn() };
  const controller = new OpsController(
    outbox as unknown as OutboxService,
    clock,
  );
  const record = newOutboxRecord(
    {
      deliveryId: 'd1',
      confirmationCode: 'abcde',
      reservationId: 'R-1',
      guest: 'ana@example.com',
    },
    now,
    'a'.repeat(64),
  );

  beforeEach(() => {
    outbox.list.mockReset();
    outbox.get.mockReset();
    outbox.retryNow.mockReset();
  });

  it('list passes filters through', async () => {
    outbox.list.mockResolvedValue([record]);

    const items = await controller.list({ status: 'pending', attention: true });

    expect(outbox.list).toHaveBeenCalledWith({
      status: 'pending',
      attention: true,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('ackToken');
  });

  it('get 404', async () => {
    outbox.get.mockResolvedValue(null);

    await expect(controller.get('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('get returns the record without its ackToken', async () => {
    outbox.get.mockResolvedValue(record);

    const view = await controller.get('d1');

    expect(view).not.toHaveProperty('ackToken');
    expect(view).toMatchObject({ deliveryId: 'd1', status: 'pending' });
  });

  it('retry-now schedules or 404s', async () => {
    outbox.retryNow.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(controller.retryNow('d1')).resolves.toEqual({
      scheduled: true,
    });
    expect(outbox.retryNow).toHaveBeenCalledWith('d1', now);
    await expect(controller.retryNow('d1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
