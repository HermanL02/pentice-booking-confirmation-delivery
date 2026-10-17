import { timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Request } from 'express';
import { appConfig } from '../config/app.config';

/** Admits a request only when its `x-api-key` header equals OPS_API_KEY. */
@Injectable()
export class OpsApiKeyGuard implements CanActivate {
  constructor(
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers[
      'x-api-key'
    ];
    const given = Array.isArray(header) ? header[0] : header;
    if (given === undefined || !keysMatch(this.cfg.opsApiKey, given)) {
      throw new UnauthorizedException('invalid api key');
    }
    return true;
  }
}

function keysMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
