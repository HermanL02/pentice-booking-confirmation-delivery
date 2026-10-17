export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/**
 * Polls `fn` until it returns a truthy value without throwing, and resolves
 * with that value. Rejects with `waitFor timed out: <label>` after `timeoutMs`.
 */
export async function waitFor<T>(
  fn: () => Promise<T> | T,
  opts: WaitForOptions = {},
): Promise<T> {
  const { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out: ${label}`);
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}
