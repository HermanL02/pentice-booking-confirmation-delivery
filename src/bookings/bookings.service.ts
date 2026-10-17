import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CLOCK, type Clock } from '../common/clock';
import { newOutboxRecord } from '../delivery/outbox.record';
import {
  own,
  STORAGE,
  type OutboxRecord,
  type StoragePort,
} from '../storage/storage.port';
import { CodeCollisionError, generateUniqueCode } from './code-generator';
import type { CreateBookingDto } from './dto/create-booking.dto';
import {
  BOOKING_CREATED,
  BookingCreatedEvent,
} from './events/booking-created.event';

export interface CreateBookingResult {
  created: boolean;
  reservationId: string;
  deliveryId: string;
  status: 'pending';
}

export interface BookingView {
  reservationId: string;
  guest: string;
  confirmationCode: string;
  createdAt: string;
  delivery: {
    status: OutboxRecord['status'];
    attempts: number;
    ackedAt: string | null;
  };
}

@Injectable()
export class BookingsService {
  constructor(
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventEmitter2,
  ) {}

  async create(dto: CreateBookingDto): Promise<CreateBookingResult> {
    const { reservationId, guest } = dto;
    const result = await this.storage.mutate((draft): CreateBookingResult => {
      const existingCode = own(draft.reservationIndex, reservationId);
      const existing =
        existingCode === undefined
          ? undefined
          : own(draft.bookings, existingCode);
      if (existing !== undefined) {
        if (existing.guest !== guest) {
          throw new ConflictException(
            'reservationId already booked with a different guest',
          );
        }
        return {
          created: false,
          reservationId,
          deliveryId: existing.deliveryId,
          status: 'pending',
        };
      }

      const code = allocateCode((c) => Object.hasOwn(draft.bookings, c));
      const deliveryId = randomUUID();
      const now = this.clock.now();
      draft.bookings[code] = {
        reservationId,
        guest,
        confirmationCode: code,
        deliveryId,
        createdAt: now.toISOString(),
      };
      draft.reservationIndex[reservationId] = code;
      draft.outbox[deliveryId] = newOutboxRecord(
        { deliveryId, confirmationCode: code, reservationId, guest },
        now,
      );
      return { created: true, reservationId, deliveryId, status: 'pending' };
    });

    if (result.created) {
      this.events.emit(
        BOOKING_CREATED,
        new BookingCreatedEvent(result.deliveryId),
      );
    }
    return result;
  }

  async findByCode(code: string): Promise<BookingView> {
    const state = await this.storage.read();
    const booking = own(state.bookings, code.toLowerCase());
    if (booking === undefined) {
      throw new NotFoundException('booking not found');
    }
    const record = own(state.outbox, booking.deliveryId);
    return {
      reservationId: booking.reservationId,
      guest: booking.guest,
      confirmationCode: booking.confirmationCode,
      createdAt: booking.createdAt,
      delivery:
        record === undefined
          ? { status: 'pending', attempts: 0, ackedAt: null }
          : {
              status: record.status,
              attempts: record.attempts,
              ackedAt: record.ackedAt,
            },
    };
  }
}

/** Spec 4.5: five collisions in a row is a capacity problem, reported as 503. */
function allocateCode(taken: (code: string) => boolean): string {
  try {
    return generateUniqueCode(taken);
  } catch (err) {
    if (err instanceof CodeCollisionError) {
      throw new ServiceUnavailableException(
        'could not allocate a unique confirmation code',
      );
    }
    throw err;
  }
}
