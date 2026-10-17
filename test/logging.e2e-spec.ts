import request from 'supertest';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { waitFor } from './helpers/wait-for';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RequestLogLine {
  req?: { id?: string; url?: string };
  correlationId?: string;
}

describe('request logging (e2e)', () => {
  let t: TestApp;
  let stdout: jest.SpyInstance;
  const written: string[] = [];

  /** Parsed JSON lines pino wrote to stdout so far. */
  const logLines = (): RequestLogLine[] =>
    written
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as RequestLogLine);

  const requestLine = (id: string) =>
    waitFor(() => logLines().find((l) => l.req?.id === id), {
      label: `request log line with id ${id}`,
    });

  beforeAll(async () => {
    // Without a BetterStack token pino writes to process.stdout. Lines are
    // kept for the assertions and not forwarded, so the run stays quiet.
    stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      });
    t = await createTestApp({ LOG_LEVEL: 'info' });
  });

  afterAll(async () => {
    try {
      await t?.close();
    } finally {
      stdout.mockRestore();
    }
  });

  it('logs the request with the x-correlation-id it was sent and echoes it', async () => {
    const id = `corr-${Date.now()}`;

    const res = await request(t.baseUrl)
      .get('/health')
      .set('x-correlation-id', id);

    expect(res.headers['x-correlation-id']).toBe(id);
    const line = await requestLine(id);
    expect(line).toMatchObject({
      correlationId: id,
      req: { id, url: '/health' },
    });
  });

  it('generates a uuid when none is sent, and logs that same id', async () => {
    const res = await request(t.baseUrl).get('/health');

    const id = res.headers['x-correlation-id'];
    expect(id).toMatch(UUID);
    await expect(requestLine(id)).resolves.toMatchObject({
      correlationId: id,
    });
  });
});
