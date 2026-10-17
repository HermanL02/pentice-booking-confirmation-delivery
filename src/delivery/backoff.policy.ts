/** Exponential backoff with full jitter. */
export class BackoffPolicy {
  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly random: () => number = Math.random,
  ) {}

  /** `attempts` is the number of attempts made so far (>= 1). */
  delayMs(attempts: number): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** (attempts - 1));
    return Math.floor(this.random() * ceiling);
  }
}
