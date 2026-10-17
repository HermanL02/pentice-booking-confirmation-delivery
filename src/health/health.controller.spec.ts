import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { StorageHealthIndicator } from './storage.health';

describe('HealthController', () => {
  it('returns status ok', async () => {
    const module = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        {
          provide: StorageHealthIndicator,
          useValue: {
            isHealthy: () => Promise.resolve({ storage: { status: 'up' } }),
          },
        },
      ],
    }).compile();
    module.useLogger(false);

    const result = await module.get(HealthController).check();

    expect(result.status).toBe('ok');
  });
});
