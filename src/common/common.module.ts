import { Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { OpsApiKeyGuard } from './ops-api-key.guard';

@Module({
  providers: [CorrelationIdMiddleware, OpsApiKeyGuard, AlertsService],
  exports: [CorrelationIdMiddleware, OpsApiKeyGuard],
})
export class CommonModule {}
