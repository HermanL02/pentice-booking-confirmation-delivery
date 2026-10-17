import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Clock } from '../common/clock';
import {
  emptyState,
  type StoragePort,
  type StoreState,
} from '../storage/storage.port';
import { BookingsService } from './bookings.service';
import { CODE_PATTERN } from './code-generator';
import { BookingCreatedEvent } from './events/booking-created.event';

class InMemoryStorage implements StoragePort {
  state: StoreState = emptyState();

  read(): Promise<StoreState> {
    return Promise.resolve(structuredClone(this.state));
  }

  async mutate<T>(fn: (draft: StoreState) => T | Promise<T>): Promise<T> {
    const draft = structuredClone(this.state);
    const result = await fn(draft);
    this.state = draft;
    return result;
  }
}

const NOW = new Date('2026-10-17T12:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('BookingsService', () => {
  let storage: InMemoryStorage;
  let emit: jest.Mock;
  let service: BookingsService;

  beforeEach(() => {
    storage = new InMemoryStorage();
    emit = jest.fn();
    const clock: Clock = { now: () => NOW };
    service = new BookingsService(storage, clock, {
      emit,
    } as unknown as EventEmitter2);
  });

  it('creates a booking with a unique lowercase code and returns created=true', async () => {
    const result = await service.create({
      reservationId: 'R123',
      guest: 'ana@example.com',
    });

    expect(result).toEqual({
      created: true,
      reservationId: 'R123',
      deliveryId: expect.stringMatching(UUID),
      status: 'pending',
    });
    const code = storage.state.reservationIndex.R123;
    expect(code).toMatch(CODE_PATTERN);
    expect(storage.state.bookings[code]).toEqual({
      reservationId: 'R123',
      guest: 'ana@example.com',
      confirmationCode: code,
      deliveryId: result.deliveryId,
      createdAt: NOW.toISOString(),
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'booking.created',
      new BookingCreatedEvent(result.deliveryId),
    );
  });

  it('returns the same deliveryId with created=false for a repeat with the same guest', async () => {
    const dto = { reservationId: 'R123', guest: 'ana@example.com' };
    const first = await service.create(dto);
    const second = await service.create(dto);

    expect(second).toEqual({
      created: false,
      reservationId: 'R123',
      deliveryId: first.deliveryId,
      status: 'pending',
    });
    expect(Object.keys(storage.state.bookings)).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('throws ConflictException for a repeat with a different guest', async () => {
    await service.create({ reservationId: 'R123', guest: 'ana@example.com' });
    const before = structuredClone(storage.state);

    await expect(
      service.create({ reservationId: 'R123', guest: 'bob@example.com' }),
    ).rejects.toThrow(ConflictException);
    expect(storage.state).toEqual(before);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('findByCode lowercases and returns the view', async () => {
    await service.create({ reservationId: 'R123', guest: 'ana@example.com' });
    const code = storage.state.reservationIndex.R123;

    await expect(service.findByCode(code.toUpperCase())).resolves.toEqual({
      reservationId: 'R123',
      guest: 'ana@example.com',
      confirmationCode: code,
      createdAt: NOW.toISOString(),
      delivery: { status: 'pending', attempts: 0, ackedAt: null },
    });
  });

  it('findByCode throws NotFoundException', async () => {
    await expect(service.findByCode('zzzzz')).rejects.toThrow(
      NotFoundException,
    );
  });
});
