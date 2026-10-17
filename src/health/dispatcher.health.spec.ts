import type { ConfigType } from '@nestjs/config';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { deliveryConfig } from '../config/delivery.config';
import type { DispatcherService } from '../delivery/dispatcher.service';
import { DispatcherHealthIndicator } from './dispatcher.health';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const TICK_MS = 1_000;

describe('DispatcherHealthIndicator', () => {
  const build = (lastTickAt: Date | null) =>
    new DispatcherHealthIndicator(
      { lastTickAt } as DispatcherService,
      { now: () => NOW },
      { tickMs: TICK_MS } as ConfigType<typeof deliveryConfig>,
      new HealthIndicatorService(),
    );

  it('reports up when the last tick is within 3 ticks', () => {
    const indicator = build(new Date(NOW.getTime() - 3 * TICK_MS));

    expect(indicator.isHealthy()).toEqual({ dispatcher: { status: 'up' } });
  });

  it('reports down when the last tick is older than 3 ticks or missing', () => {
    const stale = new Date(NOW.getTime() - 3 * TICK_MS - 1);

    expect(build(stale).isHealthy()).toEqual({
      dispatcher: { status: 'down', lastTickAt: stale.toISOString() },
    });
    expect(build(null).isHealthy()).toEqual({
      dispatcher: { status: 'down', lastTickAt: null },
    });
  });
});
