import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { appConfig } from '../config/app.config';
import { STORAGE, type StoragePort } from '../storage/storage.port';

@Injectable()
export class StorageHealthIndicator {
  constructor(
    @Inject(STORAGE) private readonly store: StoragePort,
    @Inject(appConfig.KEY) private readonly cfg: ConfigType<typeof appConfig>,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'storage'): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);
    try {
      await this.store.read();
      await fs.access(dirname(this.cfg.dataFile), constants.W_OK);
      return check.up();
    } catch (err) {
      return check.down({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
