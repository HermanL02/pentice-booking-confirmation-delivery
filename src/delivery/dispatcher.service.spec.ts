import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { Clock } from '../common/clock';
import type { appConfig } from '../config/app.config';
import type { deliveryConfig } from '../config/delivery.config';
import type { OutboxRecord } from '../storage/storage.port';
import { DispatcherService } from './dispatcher.service';
import type { MetricsService } from './metrics.service';
import { newOutboxRecord } from './outbox.record';
import type { OutboxService } from './outbox.service';
import { TransportError } from './transport/delivery-transport.port';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const BASE_URL = 'http://localhost:3000';

const record = (deliveryId: string): OutboxRecord =>
  newOutboxRecord(
    {
      deliveryId,
      confirmationCode: 'abcde',
      reservationId: `R-${deliveryId}`,
      guest: 'ana@example.com',
    },
    NOW,
    'a'.repeat(64),
  );

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('DispatcherService', () => {
  let outbox: {
    claimDue: jest.Mock;
    claimOne: jest.Mock;
    recordOutcome: jest.Mock;
    releaseLease: jest.Mock;
  };
  let transport: { send: jest.Mock };
  let metrics: { recordTick: jest.Mock; incrementTransportFailures: jest.Mock };
  let registry: {
    addInterval: jest.Mock;
    deleteInterval: jest.Mock;
    doesExist: jest.Mock;
  };

  const build = (shutdownDrainMs = 1_000): DispatcherService => {
    const clock: Clock = { now: () => NOW };
    const delivery = {
      tickMs: 1_000,
      leaseMs: 30_000,
      shutdownDrainMs,
    } as ConfigType<typeof deliveryConfig>;
    const app = { publicBaseUrl: BASE_URL } as ConfigType<typeof appConfig>;
    return new DispatcherService(
      outbox as unknown as OutboxService,
      transport,
      clock,
      delivery,
      app,
      registry as unknown as SchedulerRegistry,
      metrics as unknown as MetricsService,
    );
  };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    outbox = {
      claimDue: jest.fn().mockResolvedValue([]),
      claimOne: jest.fn().mockResolvedValue(null),
      recordOutcome: jest
        .fn()
        .mockImplementation((id: string) => Promise.resolve(record(id))),
      releaseLease: jest
        .fn()
        .mockImplementation((ids: string[]) => Promise.resolve(ids.length)),
    };
    transport = { send: jest.fn().mockResolvedValue('sent') };
    metrics = { recordTick: jest.fn(), incrementTransportFailures: jest.fn() };
    registry = {
      addInterval: jest.fn(),
      deleteInterval: jest.fn(),
      doesExist: jest.fn().mockReturnValue(true),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('tick sends every claimed record and records sent', async () => {
    outbox.claimDue.mockResolvedValue([record('d1'), record('d2')]);
    const service = build();

    await service.tick();

    expect(outbox.claimDue).toHaveBeenCalledWith(NOW, 30_000);
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'd1',
        ackUrl: `${BASE_URL}/deliveries/d1/ack`,
      }),
    );
    expect(outbox.recordOutcome).toHaveBeenCalledWith('d1', 'sent', NOW);
    expect(outbox.recordOutcome).toHaveBeenCalledWith('d2', 'sent', NOW);
    expect(service.lastTickAt).toEqual(NOW);
  });

  it('tick records failed with the transport error kind and message', async () => {
    outbox.claimDue.mockResolvedValue([record('d1'), record('d2')]);
    transport.send
      .mockRejectedValueOnce(new TransportError('HTTP 503', 'failed'))
      .mockRejectedValueOnce(new TransportError('timed out', 'timeout'));
    const service = build();

    await service.tick();

    expect(outbox.recordOutcome).toHaveBeenCalledWith(
      'd1',
      'failed',
      NOW,
      'HTTP 503',
    );
    expect(outbox.recordOutcome).toHaveBeenCalledWith(
      'd2',
      'timeout',
      NOW,
      'timed out',
    );
  });

  it('tick records the tick and each transport failure in metrics', async () => {
    outbox.claimDue.mockResolvedValue([
      record('d1'),
      record('d2'),
      record('d3'),
    ]);
    transport.send
      .mockRejectedValueOnce(new TransportError('HTTP 503', 'failed'))
      .mockRejectedValueOnce(new Error('not a transport error'))
      .mockResolvedValueOnce('sent');
    const service = build();

    await service.tick();

    expect(metrics.recordTick).toHaveBeenCalledWith(NOW);
    expect(metrics.incrementTransportFailures).toHaveBeenCalledTimes(1);
  });

  it('tick does not overlap', async () => {
    const claim = deferred<OutboxRecord[]>();
    outbox.claimDue.mockReturnValue(claim.promise);
    const service = build();

    const first = service.tick();
    const second = service.tick();
    await second;
    claim.resolve([]);
    await first;

    expect(outbox.claimDue).toHaveBeenCalledTimes(1);
  });

  it('tick survives a throwing transport', async () => {
    outbox.claimDue.mockResolvedValue([record('d1'), record('d2')]);
    transport.send
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('sent');
    outbox.recordOutcome.mockImplementation((id: string) =>
      id === 'd2'
        ? Promise.reject(new Error('storage down'))
        : Promise.resolve(record(id)),
    );
    const service = build();

    await expect(service.tick()).resolves.toBeUndefined();

    expect(outbox.recordOutcome).toHaveBeenCalledWith(
      'd1',
      'failed',
      NOW,
      'boom',
    );
    expect(outbox.recordOutcome).toHaveBeenCalledWith('d2', 'sent', NOW);
  });

  it('tick sends at most 10 records concurrently', async () => {
    outbox.claimDue.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => record(`d${i}`)),
    );
    let active = 0;
    let peak = 0;
    transport.send.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active -= 1;
      return 'sent';
    });
    const service = build();

    await service.tick();

    expect(transport.send).toHaveBeenCalledTimes(25);
    expect(peak).toBe(10);
  });

  it('handed-off leaves the record leased and records nothing', async () => {
    outbox.claimDue.mockResolvedValue([record('d1')]);
    transport.send.mockResolvedValue('handed-off');
    const service = build();

    await service.tick();

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(outbox.recordOutcome).not.toHaveBeenCalled();
  });

  it('onBookingCreated dispatches that delivery immediately', async () => {
    outbox.claimOne.mockResolvedValue(record('d1'));
    const service = build();

    await service.onBookingCreated({ deliveryId: 'd1' });

    expect(outbox.claimOne).toHaveBeenCalledWith('d1', NOW, 30_000);
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'd1' }),
    );
    expect(outbox.recordOutcome).toHaveBeenCalledWith('d1', 'sent', NOW);
  });

  it('onBookingCreated never rejects', async () => {
    outbox.claimOne.mockRejectedValue(new Error('storage down'));
    const service = build();

    await expect(
      service.onBookingCreated({ deliveryId: 'd1' }),
    ).resolves.toBeUndefined();
    await expect(
      service.onBookingCreated(undefined as unknown as { deliveryId: string }),
    ).resolves.toBeUndefined();
  });

  it('onApplicationBootstrap registers the interval and ticks once', async () => {
    const service = build();

    service.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));

    expect(registry.addInterval).toHaveBeenCalledWith(
      'dispatcher',
      expect.anything(),
    );
    expect(outbox.claimDue).toHaveBeenCalledTimes(1);
    clearInterval(registry.addInterval.mock.calls[0][1] as NodeJS.Timeout);
  });

  describe('onModuleDestroy waits for in-flight sends up to the drain limit', () => {
    const startSlowSend = async (service: DispatcherService) => {
      outbox.claimDue.mockResolvedValue([record('d1')]);
      let settled = false;
      transport.send.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              settled = true;
              resolve('sent');
            }, 50),
          ),
      );
      void service.tick();
      await jest.advanceTimersByTimeAsync(0);
      expect(transport.send).toHaveBeenCalledTimes(1);
      return () => settled;
    };

    it('resolves only after the in-flight send settles', async () => {
      jest.useFakeTimers();
      const service = build(1_000);
      const sendSettled = await startSlowSend(service);
      let done = false;

      const destroyed = service.onModuleDestroy().then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(49);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await destroyed;

      expect(sendSettled()).toBe(true);
      expect(outbox.recordOutcome).toHaveBeenCalledWith('d1', 'sent', NOW);
      expect(registry.deleteInterval).toHaveBeenCalledWith('dispatcher');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('resolves at the drain limit with a warning when sends outlast it', async () => {
      jest.useFakeTimers();
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const service = build(20);
      const sendSettled = await startSlowSend(service);
      let done = false;

      const destroyed = service.onModuleDestroy().then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(19);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await destroyed;

      expect(sendSettled()).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('with 1 dispatch(es) still in flight'),
      );
      await jest.advanceTimersByTimeAsync(30);
    });

    it('onModuleDestroy waits for a dispatchOne that is still claiming', async () => {
      const claim = deferred<OutboxRecord | null>();
      outbox.claimOne.mockReturnValue(claim.promise);
      const service = build();
      let done = false;

      const dispatched = service.dispatchOne('d1');
      const destroyed = service.onModuleDestroy().then(() => {
        done = true;
      });
      await new Promise((r) => setImmediate(r));
      expect(done).toBe(false);
      claim.resolve(record('d1'));
      await destroyed;
      await dispatched;

      expect(transport.send).not.toHaveBeenCalled();
      expect(outbox.releaseLease).toHaveBeenCalledWith(['d1'], NOW);
    });

    it('stopping releases claimed records that were never sent', async () => {
      // 12 claimed: the first 10 occupy every worker slot, so 2 are never sent.
      const ids = Array.from({ length: 12 }, (_, i) => `d${i}`);
      outbox.claimDue.mockResolvedValue(ids.map(record));
      const sends: Array<() => void> = [];
      transport.send.mockImplementation(
        () =>
          new Promise((resolve) => {
            sends.push(() => resolve('sent'));
          }),
      );
      const service = build();

      const ticked = service.tick();
      await new Promise((r) => setImmediate(r));
      expect(transport.send).toHaveBeenCalledTimes(10);
      const destroyed = service.onModuleDestroy();
      for (const release of sends) release();
      await destroyed;
      await ticked;

      expect(transport.send).toHaveBeenCalledTimes(10);
      expect(outbox.releaseLease).toHaveBeenCalledTimes(1);
      expect(outbox.releaseLease).toHaveBeenCalledWith(['d10', 'd11'], NOW);
    });

    it('stops claiming once stopping', async () => {
      const service = build();
      await service.onModuleDestroy();

      await service.tick();
      await service.dispatchOne('d1');

      expect(outbox.claimDue).not.toHaveBeenCalled();
      expect(outbox.claimOne).not.toHaveBeenCalled();
    });
  });
});
