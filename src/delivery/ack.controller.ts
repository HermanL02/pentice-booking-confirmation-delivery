import {
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CLOCK, type Clock } from '../common/clock';
import { AckDto } from './dto/ack.dto';
import { OutboxService } from './outbox.service';

@ApiTags('deliveries')
@Controller('deliveries')
export class AckController {
  constructor(
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post(':deliveryId/ack')
  @HttpCode(200)
  @ApiResponse({ status: 200, description: 'Delivery acknowledged' })
  @ApiResponse({ status: 401, description: 'Invalid ack token' })
  @ApiResponse({ status: 404, description: 'Unknown delivery' })
  async ack(
    @Param('deliveryId') deliveryId: string,
    @Body() dto: AckDto,
  ): Promise<{ status: 'acked' | 'already-acked' }> {
    const result = await this.outbox.ack(
      deliveryId,
      dto.ackToken,
      this.clock.now(),
    );
    switch (result) {
      case 'invalid-token':
        throw new UnauthorizedException('invalid ack token');
      case 'not-found':
        throw new NotFoundException('delivery not found');
      default:
        return { status: result };
    }
  }
}
