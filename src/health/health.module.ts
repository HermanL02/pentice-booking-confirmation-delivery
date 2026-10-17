import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DeliveryModule } from '../delivery/delivery.module';
import { DispatcherHealthIndicator } from './dispatcher.health';
import { HealthController } from './health.controller';
import { StorageHealthIndicator } from './storage.health';

@Module({
  imports: [TerminusModule, DeliveryModule],
  controllers: [HealthController],
  providers: [StorageHealthIndicator, DispatcherHealthIndicator],
})
export class HealthModule {}
