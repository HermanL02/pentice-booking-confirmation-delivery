import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { OpsApiKeyGuard } from '../common/ops-api-key.guard';
import { MetricsService, type MetricsSnapshot } from './metrics.service';

@ApiTags('ops')
@ApiSecurity('ops')
@UseGuards(OpsApiKeyGuard)
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @ApiResponse({ status: 200, description: 'Delivery metrics snapshot' })
  @ApiResponse({ status: 401, description: 'Missing or invalid api key' })
  snapshot(): Promise<MetricsSnapshot> {
    return this.metrics.snapshot();
  }
}
