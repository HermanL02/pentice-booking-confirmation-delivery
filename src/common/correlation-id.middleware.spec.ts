import type { NextFunction, Request, Response } from 'express';
import { CorrelationIdMiddleware } from './correlation-id.middleware';

describe('CorrelationIdMiddleware', () => {
  const middleware = new CorrelationIdMiddleware();

  const run = (headers: Record<string, string>) => {
    const req = { headers } as unknown as Request & { id?: string };
    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;
    const next = jest.fn() as NextFunction;
    middleware.use(req, res, next);
    return { req, setHeader, next };
  };

  it('reuses incoming x-correlation-id', () => {
    const { req, setHeader, next } = run({ 'x-correlation-id': 'abc-123' });
    expect(req.id).toBe('abc-123');
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'abc-123');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a uuid when absent', () => {
    const { req, setHeader, next } = run({});
    expect(req.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', req.id);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
