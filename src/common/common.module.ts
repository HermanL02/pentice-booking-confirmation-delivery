import { Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { OpsApiKeyGuard } from './ops-api-key.guard';

@Module({
  providers: [OpsApiKeyGuard, AlertsService],
  exports: [OpsApiKeyGuard],
})
export class CommonModule {}
