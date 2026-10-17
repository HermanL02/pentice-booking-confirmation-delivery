import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { StorageHealthIndicator } from './storage.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [StorageHealthIndicator],
})
export class HealthModule {}
