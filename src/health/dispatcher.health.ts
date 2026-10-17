import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { CLOCK, type Clock } from '../common/clock';
import { deliveryConfig } from '../config/delivery.config';
import { DispatcherService } from '../delivery/dispatcher.service';

const STALE_AFTER_TICKS = 3;

@Injectable()
export class DispatcherHealthIndicator {
  constructor(
    private readonly dispatcher: DispatcherService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(deliveryConfig.KEY)
    private readonly cfg: ConfigType<typeof deliveryConfig>,
    private readonly indicator: HealthIndicatorService,
  ) {}

  isHealthy(key = 'dispatcher'): HealthIndicatorResult {
    const check = this.indicator.check(key);
    const last = this.dispatcher.lastTickAt;
    if (
      last !== null &&
      this.clock.now().getTime() - last.getTime() <=
        STALE_AFTER_TICKS * this.cfg.tickMs
    ) {
      return check.up();
    }
    return check.down({ lastTickAt: last?.toISOString() ?? null });
  }
}
