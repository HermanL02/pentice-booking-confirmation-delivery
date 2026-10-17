import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns status ok', async () => {
    const module = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
    }).compile();
    module.useLogger(false);

    const result = await module.get(HealthController).check();

    expect(result.status).toBe('ok');
  });
});
