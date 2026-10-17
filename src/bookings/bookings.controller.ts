import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  BookingsService,
  type BookingView,
  type CreateBookingResult,
} from './bookings.service';
import { ConfirmationCodePipe } from './confirmation-code.pipe';
import { CreateBookingDto } from './dto/create-booking.dto';

@ApiTags('bookings')
@Controller()
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post('bookings')
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiResponse({
    status: 202,
    description: 'Booking created; delivery pending',
    schema: {
      example: {
        reservationId: 'R123',
        deliveryId: '724de8f9-6d0a-485a-8960-3e3d81913aa4',
        status: 'pending',
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      "Repeat of an existing booking; status is the delivery's current status",
    schema: {
      example: {
        reservationId: 'R123',
        deliveryId: '724de8f9-6d0a-485a-8960-3e3d81913aa4',
        status: 'acked',
      },
    },
  })
  @ApiResponse({
    status: 409,
    description: 'reservationId already booked with a different guest',
  })
  async create(
    @Body() dto: CreateBookingDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<CreateBookingResult, 'created'>> {
    const { created, reservationId, deliveryId, status } =
      await this.bookings.create(dto);
    if (!created) res.status(HttpStatus.OK);
    return { reservationId, deliveryId, status };
  }

  @Get(':code')
  @ApiResponse({ status: 200, description: 'Booking found' })
  @ApiResponse({ status: 404, description: 'Unknown confirmation code' })
  findByCode(
    @Param('code', ConfirmationCodePipe) code: string,
  ): Promise<BookingView> {
    return this.bookings.findByCode(code);
  }
}
