import {
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CLOCK, type Clock } from '../common/clock';
import { OpsApiKeyGuard } from '../common/ops-api-key.guard';
import type { OutboxRecord } from '../storage/storage.port';
import { ListDeliveriesQuery } from './dto/list-deliveries.query';
import { OutboxService } from './outbox.service';

/** The ackToken is the guest device's credential; operators never see it. */
export type DeliveryView = Omit<OutboxRecord, 'ackToken'>;

function toView(record: OutboxRecord): DeliveryView {
  const view: Partial<OutboxRecord> = { ...record };
  delete view.ackToken;
  return view as DeliveryView;
}

@ApiTags('deliveries')
@ApiSecurity('ops')
@UseGuards(OpsApiKeyGuard)
@Controller('deliveries')
export class OpsController {
  constructor(
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @ApiResponse({ status: 200, description: 'Outbox records, oldest first' })
  @ApiResponse({ status: 401, description: 'Missing or invalid api key' })
  async list(@Query() query: ListDeliveriesQuery): Promise<DeliveryView[]> {
    const records = await this.outbox.list({
      status: query.status,
      attention: query.attention,
    });
    return records.map(toView);
  }

  @Get(':deliveryId')
  @ApiResponse({ status: 200, description: 'Outbox record' })
  @ApiResponse({ status: 401, description: 'Missing or invalid api key' })
  @ApiResponse({ status: 404, description: 'Unknown delivery' })
  async get(@Param('deliveryId') deliveryId: string): Promise<DeliveryView> {
    const record = await this.outbox.get(deliveryId);
    if (record === null) throw new NotFoundException('delivery not found');
    return toView(record);
  }

  @Post(':deliveryId/retry-now')
  @HttpCode(200)
  @ApiResponse({ status: 200, description: 'Due on the next tick' })
  @ApiResponse({ status: 401, description: 'Missing or invalid api key' })
  @ApiResponse({ status: 404, description: 'Unknown or already acked' })
  async retryNow(
    @Param('deliveryId') deliveryId: string,
  ): Promise<{ scheduled: true }> {
    if (!(await this.outbox.retryNow(deliveryId, this.clock.now()))) {
      throw new NotFoundException('pending delivery not found');
    }
    return { scheduled: true };
  }
}
