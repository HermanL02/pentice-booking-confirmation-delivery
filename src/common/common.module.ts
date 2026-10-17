import { Module } from '@nestjs/common';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { OpsApiKeyGuard } from './ops-api-key.guard';

@Module({
  providers: [CorrelationIdMiddleware, OpsApiKeyGuard],
  exports: [CorrelationIdMiddleware, OpsApiKeyGuard],
})
export class CommonModule {}
