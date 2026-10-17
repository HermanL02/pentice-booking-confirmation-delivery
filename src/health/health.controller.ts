import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { DispatcherHealthIndicator } from './dispatcher.health';
import { StorageHealthIndicator } from './storage.health';

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly storage: StorageHealthIndicator,
    private readonly dispatcher: DispatcherHealthIndicator,
  ) {}

  @Get('health')
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.storage.isHealthy('storage'),
      () => this.dispatcher.isHealthy('dispatcher'),
    ]);
  }
}
