import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { appConfig } from '../config/app.config';
import { OpsApiKeyGuard } from './ops-api-key.guard';

describe('OpsApiKeyGuard', () => {
  const guard = new OpsApiKeyGuard({ opsApiKey: 'secret' } as ConfigType<
    typeof appConfig
  >);

  const context = (headers: Record<string, string | string[]>) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    }) as unknown as ExecutionContext;

  it('allows matching key', () => {
    expect(guard.canActivate(context({ 'x-api-key': 'secret' }))).toBe(true);
    expect(guard.canActivate(context({ 'x-api-key': ['secret', 'x'] }))).toBe(
      true,
    );
  });

  it('rejects missing', () => {
    expect(() => guard.canActivate(context({}))).toThrow(UnauthorizedException);
  });

  it('rejects wrong', () => {
    expect(() => guard.canActivate(context({ 'x-api-key': 'secreT' }))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(context({ 'x-api-key': 'sec' }))).toThrow(
      UnauthorizedException,
    );
  });
});
