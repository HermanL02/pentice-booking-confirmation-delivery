import { Injectable } from '@nestjs/common';
import { OutboxService } from './outbox.service';

export interface MetricsSnapshot {
  pending: number;
  acked: number;
  cancelled: number;
  /** Pending records flagged for attention; an acked record no longer needs any. */
  needsAttention: number;
  /** Records by attempts made; records with no attempt yet are not counted. */
  attemptsHistogram: {
    '1': number;
    '2-3': number;
    '4-10': number;
    '11+': number;
  };
  timeToAckMs: { p50: number | null; p95: number | null; p99: number | null };
  ticks: number;
  transportFailures: number;
  lastTickAt: string | null;
}

/**
 * Outbox-derived gauges plus dispatcher counters. The dispatcher pushes into
 * it, so this never depends on DispatcherService.
 */
@Injectable()
export class MetricsService {
  private ticks = 0;
  private transportFailures = 0;
  private lastTickAt: Date | null = null;

  constructor(private readonly outbox: OutboxService) {}

  recordTick(now: Date): void {
    this.ticks += 1;
    this.lastTickAt = now;
  }

  incrementTransportFailures(): void {
    this.transportFailures += 1;
  }

  async snapshot(): Promise<MetricsSnapshot> {
    const records = await this.outbox.list({});
    const histogram = { '1': 0, '2-3': 0, '4-10': 0, '11+': 0 };
    const ackMs: number[] = [];
    let pending = 0;
    let cancelled = 0;
    let needsAttention = 0;
    for (const r of records) {
      if (r.status === 'pending') {
        pending += 1;
        if (r.needsAttention) needsAttention += 1;
      } else if (r.status === 'cancelled') {
        cancelled += 1;
      } else if (r.ackedAt !== null) {
        ackMs.push(Date.parse(r.ackedAt) - Date.parse(r.createdAt));
      }
      const bucket = bucketOf(r.attempts);
      if (bucket !== null) histogram[bucket] += 1;
    }
    ackMs.sort((a, b) => a - b);
    return {
      pending,
      acked: records.length - pending - cancelled,
      cancelled,
      needsAttention,
      attemptsHistogram: histogram,
      timeToAckMs: {
        p50: nearestRank(ackMs, 50),
        p95: nearestRank(ackMs, 95),
        p99: nearestRank(ackMs, 99),
      },
      ticks: this.ticks,
      transportFailures: this.transportFailures,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
    };
  }
}

function bucketOf(
  attempts: number,
): keyof MetricsSnapshot['attemptsHistogram'] | null {
  if (attempts < 1) return null;
  if (attempts === 1) return '1';
  if (attempts <= 3) return '2-3';
  if (attempts <= 10) return '4-10';
  return '11+';
}

/** Nearest-rank percentile of an ascending list; null when it is empty. */
function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}
