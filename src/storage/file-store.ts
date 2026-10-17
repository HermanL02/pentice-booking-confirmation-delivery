import * as nodeFs from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Mutex } from 'async-mutex';
import type { OnModuleInit } from '@nestjs/common';
import { emptyState, type StoragePort, type StoreState } from './storage.port';

export interface FileStoreOptions {
  filePath: string;
  latencyMs?: number;
  fs?: Pick<
    typeof import('node:fs/promises'),
    'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'open'
  >;
}

/**
 * Whole-state JSON file store. Every mutation is serialised and persisted with
 * write-to-temp, fsync, rename, so the file on disk is always a complete state.
 */
export class FileStore implements StoragePort, OnModuleInit {
  private readonly filePath: string;
  private readonly latencyMs: number;
  private readonly fs: NonNullable<FileStoreOptions['fs']>;
  private readonly mutex = new Mutex();
  private state: StoreState = emptyState();

  constructor(opts: FileStoreOptions) {
    this.filePath = opts.filePath;
    this.latencyMs = opts.latencyMs ?? 0;
    this.fs = opts.fs ?? nodeFs;
  }

  async onModuleInit(): Promise<void> {
    await this.fs.mkdir(dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await this.fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.state = await this.persist(emptyState());
      return;
    }
    this.state = this.parse(raw);
  }

  async read(): Promise<StoreState> {
    await this.delay();
    return structuredClone(this.state);
  }

  async mutate<T>(fn: (draft: StoreState) => T | Promise<T>): Promise<T> {
    await this.delay();
    return this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      this.state = await this.persist(draft);
      return result;
    });
  }

  private parse(raw: string): StoreState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw this.corrupt((err as Error).message);
    }
    if (!isStoreState(parsed))
      throw this.corrupt('unexpected shape or version');
    return parsed;
  }

  private corrupt(reason: string): Error {
    return new Error(`Store file ${this.filePath} is corrupt: ${reason}`);
  }

  /**
   * Atomically writes `state` and returns a fresh copy parsed from the exact
   * bytes written, so the cache matches the file and never aliases `state`.
   */
  private async persist(state: StoreState): Promise<StoreState> {
    const serialized = JSON.stringify(state, null, 2);
    const tmp = `${this.filePath}.tmp`;
    await this.fs.writeFile(tmp, serialized, 'utf8');
    const handle = await this.fs.open(tmp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.fs.rename(tmp, this.filePath);
    return JSON.parse(serialized) as StoreState;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStoreState = (v: unknown): v is StoreState =>
  isRecord(v) &&
  v.version === 1 &&
  isRecord(v.bookings) &&
  isRecord(v.reservationIndex) &&
  isRecord(v.outbox);
