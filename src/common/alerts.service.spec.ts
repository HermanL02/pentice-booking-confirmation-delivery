import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import type { appConfig } from '../config/app.config';
import { AlertsService } from './alerts.service';

jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn() }));

describe('AlertsService', () => {
  const event = { deliveryId: 'd1', attempts: 10 };
  const build = (sentryDsn: string | undefined) =>
    new AlertsService({ sentryDsn } as ConfigType<typeof appConfig>);
  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.mocked(Sentry.captureMessage).mockReset();
  });

  it('logs error on attention', () => {
    build(undefined).onAttention(event);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('deliveryId=d1 attempts=10'),
    );
  });

  it('calls sentry when dsn set', () => {
    build('https://key@o0.ingest.sentry.io/0').onAttention(event);

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'delivery needs attention',
      { level: 'error', extra: event },
    );
  });

  it('does not call sentry when dsn unset', () => {
    build(undefined).onAttention(event);
    build('').onAttention(event);

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });
});
