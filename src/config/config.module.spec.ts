import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { appConfig } from './app.config';
import { deliveryConfig } from './delivery.config';
import { envSchema } from './env.schema';
import { pubsubConfig } from './pubsub.config';

const compile = (): Promise<TestingModule> =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        validationSchema: envSchema,
        validationOptions: { abortEarly: false },
        load: [appConfig, deliveryConfig, pubsubConfig],
      }),
    ],
  }).compile();

describe('config module boot', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { OPS_API_KEY: 'k' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves namespaces with the spec defaults', async () => {
    const module = await compile();
    const app = module.get<ReturnType<typeof appConfig>>(appConfig.KEY);
    const delivery = module.get<ReturnType<typeof deliveryConfig>>(
      deliveryConfig.KEY,
    );
    const pubsub = module.get<ReturnType<typeof pubsubConfig>>(
      pubsubConfig.KEY,
    );

    expect(app.port).toBe(3000);
    expect(app.dataFile).toBe('./data/store.json');
    expect(app.betterstackIngestHost).toBe('https://in.logs.betterstack.com');
    expect(delivery.tickMs).toBe(1000);
    expect(delivery.backoffMaxMs).toBe(300000);
    expect(pubsub.enabled).toBe(false);
    expect(pubsub.topic).toBe('confirmation-deliveries');
  });

  it('fails to boot when OPS_API_KEY is absent', async () => {
    process.env = {};
    await expect(compile()).rejects.toThrow(/OPS_API_KEY/);
  });

  it('enables pubsub when PUBSUB_EMULATOR_HOST is set', async () => {
    process.env.PUBSUB_EMULATOR_HOST = 'localhost:8085';
    const module = await compile();
    const pubsub = module.get<ReturnType<typeof pubsubConfig>>(
      pubsubConfig.KEY,
    );

    expect(pubsub.enabled).toBe(true);
    expect(pubsub.emulatorHost).toBe('localhost:8085');
  });
});
