import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Clock } from '../common/clock';
import {
  emptyState,
  type StoragePort,
  type StoreState,
} from '../storage/storage.port';
import { BookingsService } from './bookings.service';
import * as codeGenerator from './code-generator';
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

  it("a repeat reports the delivery's actual status once it is acked", async () => {
    const dto = { reservationId: 'R123', guest: 'ana@example.com' };
    const first = await service.create(dto);
    storage.state.outbox[first.deliveryId].status = 'acked';

    await expect(service.create(dto)).resolves.toEqual({
      created: false,
      reservationId: 'R123',
      deliveryId: first.deliveryId,
      status: 'acked',
    });
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
      status: 'active',
      reservationId: 'R123',
      guest: 'ana@example.com',
      confirmationCode: code,
      createdAt: NOW.toISOString(),
      delivery: { status: 'pending', attempts: 0, ackedAt: null },
    });
  });

  it('creates the outbox record in the same mutation', async () => {
    const mutate = jest.spyOn(storage, 'mutate');

    const result = await service.create({
      reservationId: 'R123',
      guest: 'ana@example.com',
    });

    expect(mutate).toHaveBeenCalledTimes(1);
    const code = storage.state.reservationIndex.R123;
    expect(storage.state.bookings[code].deliveryId).toBe(result.deliveryId);
    expect(storage.state.outbox[result.deliveryId]).toEqual({
      deliveryId: result.deliveryId,
      confirmationCode: code,
      reservationId: 'R123',
      guest: 'ana@example.com',
      ackToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: 'pending',
      kind: 'confirmation',
      waitsFor: null,
      attempts: 0,
      nextAttemptAt: NOW.toISOString(),
      leaseUntil: null,
      lastSentAt: null,
      ackedAt: null,
      needsAttention: false,
      createdAt: NOW.toISOString(),
      history: [],
    });
  });

  it('findByCode reports delivery state from the outbox record', async () => {
    const { deliveryId } = await service.create({
      reservationId: 'R123',
      guest: 'ana@example.com',
    });
    const code = storage.state.reservationIndex.R123;
    Object.assign(storage.state.outbox[deliveryId], {
      status: 'acked',
      attempts: 2,
      ackedAt: NOW.toISOString(),
    });

    await expect(service.findByCode(code)).resolves.toMatchObject({
      delivery: { status: 'acked', attempts: 2, ackedAt: NOW.toISOString() },
    });
  });

  it('findByCode throws NotFoundException', async () => {
    await expect(service.findByCode('zzzzz')).rejects.toThrow(
      NotFoundException,
    );
  });

  it.each([['constructor'], ['toString'], ['hasOwnProperty']])(
    'a prototype-named reservationId %s is new on first POST and a repeat on the second',
    async (reservationId) => {
      const dto = { reservationId, guest: 'ana@example.com' };

      const first = await service.create(dto);
      const second = await service.create(dto);

      expect(first.created).toBe(true);
      expect(second).toMatchObject({
        created: false,
        deliveryId: first.deliveryId,
      });
    },
  );

  it('a __proto__ reservationId does not throw (the DTO rejects it before this)', async () => {
    await expect(
      service.create({ reservationId: '__proto__', guest: 'ana@example.com' }),
    ).resolves.toMatchObject({ created: true });
  });

  it('findByCode treats a prototype-named code as not found', async () => {
    await expect(service.findByCode('constructor')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.findByCode('__proto__')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('maps exhausted code collisions to 503 and writes nothing', async () => {
    const actual = codeGenerator.generateUniqueCode;
    const spy = jest
      .spyOn(codeGenerator, 'generateUniqueCode')
      .mockImplementation((_taken, maxTries) => actual(() => true, maxTries));
    try {
      await expect(
        service.create({ reservationId: 'R123', guest: 'ana@example.com' }),
      ).rejects.toThrow(
        new ServiceUnavailableException(
          'could not allocate a unique confirmation code',
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(storage.state).toEqual(emptyState());
    expect(emit).not.toHaveBeenCalled();
  });

  describe('cancel', () => {
    const dto = { reservationId: 'R123', guest: 'ana@example.com' };
    const notices = () =>
      Object.values(storage.state.outbox).filter(
        (r) => r.kind === 'cancellation',
      );

    it('throws NotFoundException for an unknown reservationId', async () => {
      await expect(service.cancel('R-unknown')).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.state).toEqual(emptyState());
    });

    it('is idempotent: a repeat writes no second notice', async () => {
      const { deliveryId } = await service.create(dto);

      await service.cancel('R123');
      await service.cancel('R123');

      expect(storage.state.outbox[deliveryId].status).toBe('cancelled');
      expect(notices()).toHaveLength(1);
      const code = storage.state.reservationIndex.R123;
      expect(storage.state.bookings[code]).toMatchObject({
        cancelledAt: NOW.toISOString(),
        cancellationDeliveryId: notices()[0].deliveryId,
      });
      await expect(service.findByCode(code)).resolves.toMatchObject({
        status: 'cancelled',
        delivery: { status: 'cancelled' },
      });
    });

    it('leaves an acked confirmation acked and still notifies the guest', async () => {
      const { deliveryId } = await service.create(dto);
      storage.state.outbox[deliveryId].status = 'acked';

      await service.cancel('R123');

      expect(storage.state.outbox[deliveryId].status).toBe('acked');
      expect(notices()).toHaveLength(1);
    });
  });
});
