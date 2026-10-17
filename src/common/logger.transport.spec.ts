import { buildPinoTransport } from './logger.transport';

describe('buildPinoTransport', () => {
  it('returns undefined without a token', () => {
    expect(
      buildPinoTransport({ betterstackIngestHost: 'in.logs.example.com' }),
    ).toBeUndefined();
    expect(
      buildPinoTransport({
        betterstackSourceToken: '',
        betterstackIngestHost: 'in.logs.example.com',
      }),
    ).toBeUndefined();
  });

  it('returns stdout and logtail targets with a token', () => {
    const transport = buildPinoTransport({
      betterstackSourceToken: 'tok',
      betterstackIngestHost: 'in.logs.example.com',
    });
    expect(transport?.targets).toHaveLength(2);
    expect(transport?.targets[1]).toMatchObject({
      target: '@logtail/pino',
      options: {
        sourceToken: 'tok',
        options: { endpoint: 'in.logs.example.com' },
      },
    });
  });
});
