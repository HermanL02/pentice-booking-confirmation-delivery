export const BOOKING_CREATED = 'booking.created';

export class BookingCreatedEvent {
  constructor(readonly deliveryId: string) {}
}
