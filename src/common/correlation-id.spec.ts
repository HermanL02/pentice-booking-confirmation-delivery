import type { IncomingMessage, ServerResponse } from 'node:http';
import { correlationIdFor } from './correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('correlationIdFor', () => {
  const run = (headers: IncomingMessage['headers']) => {
    const req = { headers } as IncomingMessage & { id?: unknown };
    const setHeader = jest.fn();
    const res = { setHeader } as unknown as ServerResponse;
    const id = correlationIdFor(req, res);
    return { id, req, setHeader };
  };

  it('reuses an incoming x-correlation-id', () => {
    const { id, req, setHeader } = run({ 'x-correlation-id': 'abc-123' });

    expect(id).toBe('abc-123');
    expect(req.id).toBe('abc-123');
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'abc-123');
  });

  it('takes the first value when the header repeats', () => {
    const { id } = run({
      'x-correlation-id': ['first', 'second'],
    });

    expect(id).toBe('first');
  });

  it.each([[{}], [{ 'x-correlation-id': '' }]])(
    'generates a uuid when the header is absent or empty (%j)',
    (headers) => {
      const { id, req, setHeader } = run(headers);

      expect(id).toMatch(UUID);
      expect(req.id).toBe(id);
      expect(setHeader).toHaveBeenCalledWith('x-correlation-id', id);
    },
  );
});
