import { envSchema } from './env.schema';

describe('envSchema', () => {
  it('rejects when OPS_API_KEY is missing', () => {
    const { error } = envSchema.validate({});
    expect(error?.message).toContain('OPS_API_KEY');
  });

  it('applies defaults', () => {
    const { error, value } = envSchema.validate({ OPS_API_KEY: 'k' });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      PORT: 3000,
      DELIVERY_TICK_MS: 1000,
      DELIVERY_BACKOFF_MAX_MS: 300000,
      DATA_FILE: './data/store.json',
    });
  });

  it('rejects a non-numeric DELIVERY_TICK_MS', () => {
    const { error } = envSchema.validate({
      OPS_API_KEY: 'k',
      DELIVERY_TICK_MS: 'abc',
    });
    expect(error?.message).toContain('DELIVERY_TICK_MS');
  });

  it('rejects PUBLIC_BASE_URL that is not a URI', () => {
    const { error } = envSchema.validate({
      OPS_API_KEY: 'k',
      PUBLIC_BASE_URL: 'not a uri',
    });
    expect(error?.message).toContain('PUBLIC_BASE_URL');
  });
});
