import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { CLOCK, SystemClock } from '../common/clock';
import { appConfig } from '../config/app.config';
import { FileStore } from './file-store';
import { STORAGE } from './storage.port';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE,
      useFactory: (cfg: ConfigType<typeof appConfig>) =>
        new FileStore({
          filePath: cfg.dataFile,
          latencyMs: cfg.storageLatencyMs,
        }),
      inject: [appConfig.KEY],
    },
    { provide: CLOCK, useClass: SystemClock },
  ],
  exports: [STORAGE, CLOCK],
})
export class StorageModule {}
