import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * pino-http's genReqId. It runs before any Nest middleware, so it owns the
 * correlation id: reuse a non-empty `x-correlation-id` (the first one if the
 * header repeats), else a new UUID. The id is echoed in the response header
 * and set as `req.id`, which pino-http logs on every request line.
 */
export function correlationIdFor(
  req: IncomingMessage & { id?: unknown },
  res: ServerResponse,
): string {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const first = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = first !== undefined && first !== '' ? first : randomUUID();
  res.setHeader(CORRELATION_ID_HEADER, id);
  req.id = id;
  return id;
}
