import { BackoffPolicy } from './backoff.policy';

const BASE = 1_000;
const MAX = 60_000;

describe('BackoffPolicy', () => {
  it('attempt 1 is within [0, base]', () => {
    const policy = new BackoffPolicy(BASE, MAX);
    for (let i = 0; i < 100; i++) {
      const d = policy.delayMs(1);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(BASE);
    }
  });

  it('attempt 4 is within [0, base*8]', () => {
    const policy = new BackoffPolicy(BASE, MAX);
    for (let i = 0; i < 100; i++) {
      const d = policy.delayMs(4);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(BASE * 8);
    }
  });

  it('is capped at maxMs', () => {
    const policy = new BackoffPolicy(BASE, MAX, () => 1);
    expect(policy.delayMs(30)).toBe(MAX);
  });

  it('uses injected random', () => {
    const policy = new BackoffPolicy(BASE, MAX, () => 1);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(policy.delayMs(n)).toBe(Math.min(MAX, BASE * 2 ** (n - 1)));
    }
    expect(new BackoffPolicy(BASE, MAX, () => 0.5).delayMs(3)).toBe(2_000);
  });
});
