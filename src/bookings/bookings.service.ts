import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CLOCK, type Clock } from '../common/clock';
import { newOutboxRecord } from '../delivery/outbox.record';
import {
  STORAGE,
  type OutboxRecord,
  type StoragePort,
} from '../storage/storage.port';
import { generateUniqueCode } from './code-generator';
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
      const existingCode = draft.reservationIndex[reservationId];
      if (existingCode !== undefined) {
        const existing = draft.bookings[existingCode];
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

      const code = generateUniqueCode((c) => c in draft.bookings);
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
    const booking = state.bookings[code.toLowerCase()];
    if (booking === undefined) {
      throw new NotFoundException('booking not found');
    }
    const record = state.outbox[booking.deliveryId];
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
