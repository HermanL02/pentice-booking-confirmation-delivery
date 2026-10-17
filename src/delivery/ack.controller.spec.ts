import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Clock } from '../common/clock';
import { AckController } from './ack.controller';
import type { OutboxService } from './outbox.service';

describe('AckController', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const clock: Clock = { now: () => now };
  const ack = jest.fn();
  const controller = new AckController(
    { ack } as unknown as OutboxService,
    clock,
  );
  const dto = { ackToken: 'a'.repeat(64) };

  beforeEach(() => ack.mockReset());

  it('returns acked', async () => {
    ack.mockResolvedValue('acked');
    await expect(controller.ack('d1', dto)).resolves.toEqual({
      status: 'acked',
    });
    expect(ack).toHaveBeenCalledWith('d1', dto.ackToken, now);
  });

  it('returns already-acked', async () => {
    ack.mockResolvedValue('already-acked');
    await expect(controller.ack('d1', dto)).resolves.toEqual({
      status: 'already-acked',
    });
  });

  it('throws Unauthorized on invalid-token', async () => {
    ack.mockResolvedValue('invalid-token');
    await expect(controller.ack('d1', dto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws NotFound on not-found', async () => {
    ack.mockResolvedValue('not-found');
    await expect(controller.ack('d1', dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
