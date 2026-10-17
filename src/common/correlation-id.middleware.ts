import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_ID_HEADER];
    const id =
      (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
    req.id = id;
    res.setHeader(CORRELATION_ID_HEADER, id);
    next();
  }
}
