import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileStore, type FileStoreOptions } from './file-store';
import { emptyState, type Booking } from './storage.port';

const booking: Booking = {
  reservationId: 'R-1',
  guest: 'ada@example.com',
  confirmationCode: 'ABC123',
  deliveryId: 'd-1',
  createdAt: '2026-10-17T00:00:00.000Z',
};

describe('FileStore', () => {
  let dir: string;
  let filePath: string;

  const open = async (
    opts: Partial<FileStoreOptions> = {},
  ): Promise<FileStore> => {
    const store = new FileStore({ filePath, ...opts });
    await store.onModuleInit();
    return store;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'bcd-store-'));
    filePath = join(dir, 'nested', 'store.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('initialises an empty state when the file is missing', async () => {
    const store = await open();

    expect(await store.read()).toEqual(emptyState());
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual(
      emptyState(),
    );
  });

  it('fails to start on a corrupt file', async () => {
    await fs.mkdir(join(dir, 'nested'), { recursive: true });
    await fs.writeFile(filePath, '{"version":1,"book');

    const store = new FileStore({ filePath });

    await expect(store.onModuleInit()).rejects.toThrow(/store\.json.*corrupt/);
    expect(await fs.readFile(filePath, 'utf8')).toBe('{"version":1,"book');
  });

  it('persists a mutation atomically', async () => {
    const store = await open();

    await store.mutate((d) => {
      d.bookings[booking.reservationId] = booking;
    });

    const fresh = await open();
    expect((await fresh.read()).bookings['R-1']).toEqual(booking);
    const leftovers = (await fs.readdir(join(dir, 'nested'))).filter((f) =>
      f.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('leaves the original intact when rename fails', async () => {
    const store = await open();
    await store.mutate((d) => {
      d.bookings[booking.reservationId] = booking;
    });
    const before = await fs.readFile(filePath, 'utf8');
    const previous = await store.read();

    const failing = await open({
      fs: { ...fs, rename: () => Promise.reject(new Error('disk on fire')) },
    });
    await expect(
      failing.mutate((d) => {
        d.reservationIndex['R-2'] = 'b-2';
      }),
    ).rejects.toThrow('disk on fire');

    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    expect(await failing.read()).toEqual(previous);
    expect(await (await open()).read()).toEqual(previous);
  });

  it('serialises concurrent mutations', async () => {
    const store = await open();

    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.mutate((d) => {
          d.reservationIndex[String(Object.keys(d.reservationIndex).length)] =
            'x';
        }),
      ),
    );

    expect(Object.keys((await store.read()).reservationIndex)).toHaveLength(20);
    expect(
      Object.keys((await (await open()).read()).reservationIndex),
    ).toHaveLength(20);
  });

  it('a value returned from mutate does not alias the cache', async () => {
    const store = await open();

    const b = await store.mutate((d) => {
      d.bookings['abcde'] = { ...booking, reservationId: 'abcde' };
      return d.bookings['abcde'];
    });
    b.guest = 'mallory@example.com';

    expect((await store.read()).bookings['abcde'].guest).toBe(booking.guest);
  });

  it('read returns a copy', async () => {
    const store = await open();

    const copy = await store.read();
    copy.bookings['R-1'] = booking;

    expect(await store.read()).toEqual(emptyState());
  });

  it('applies latencyMs', async () => {
    const store = await open({ latencyMs: 20 });

    const started = performance.now();
    await store.read();

    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('a mutation that changes nothing does not rewrite the file', async () => {
    const writeFile = jest.fn(fs.writeFile);
    const store = await open({ fs: { ...fs, writeFile } });
    await store.mutate((d) => {
      d.bookings[booking.reservationId] = booking;
    });
    const writes = writeFile.mock.calls.length;
    const { mtimeMs } = await fs.stat(filePath);

    const result = await store.mutate((d) => Object.keys(d.bookings));
    await store.mutate((d) => {
      d.bookings[booking.reservationId] = { ...booking };
    });

    expect(result).toEqual(['R-1']);
    expect(writeFile).toHaveBeenCalledTimes(writes);
    expect((await fs.stat(filePath)).mtimeMs).toBe(mtimeMs);
    expect((await store.read()).bookings['R-1']).toEqual(booking);

    await store.mutate((d) => {
      d.bookings['R-2'] = { ...booking, reservationId: 'R-2' };
    });
    expect(writeFile).toHaveBeenCalledTimes(writes + 1);
  });

  it('an unchanged state after boot from an existing file is not rewritten', async () => {
    const first = await open();
    await first.mutate((d) => {
      d.bookings[booking.reservationId] = booking;
    });
    const writeFile = jest.fn(fs.writeFile);
    const store = await open({ fs: { ...fs, writeFile } });

    await store.mutate(() => undefined);

    expect(writeFile).not.toHaveBeenCalled();
  });

  it('a failed write is retried by the next identical mutation', async () => {
    let fail = false;
    const failing = await open({
      fs: {
        ...fs,
        rename: (a, b) =>
          fail ? Promise.reject(new Error('disk on fire')) : fs.rename(a, b),
      },
    });
    const write = (d: { bookings: Record<string, Booking> }) => {
      d.bookings[booking.reservationId] = booking;
    };

    fail = true;
    await expect(failing.mutate(write)).rejects.toThrow('disk on fire');
    fail = false;
    await failing.mutate(write);

    const fresh = await open();
    expect((await fresh.read()).bookings['R-1']).toEqual(booking);
  });
});
