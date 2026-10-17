import type { TransportMultiOptions } from 'pino';

export function buildPinoTransport(cfg: {
  betterstackSourceToken?: string;
  betterstackIngestHost: string;
}): TransportMultiOptions | undefined {
  if (!cfg.betterstackSourceToken) return undefined;
  return {
    targets: [
      { target: 'pino/file', options: { destination: 1 } },
      {
        target: '@logtail/pino',
        options: {
          sourceToken: cfg.betterstackSourceToken,
          options: { endpoint: cfg.betterstackIngestHost },
        },
      },
    ],
  };
}
