import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import * as Sentry from '@sentry/nestjs';
import { appConfig } from '../config/app.config';
import {
  DELIVERY_ATTENTION,
  type DeliveryAttentionEvent,
} from '../delivery/events/delivery-attention.event';

/** Raises an alert when a delivery needs attention: always logged, Sentry only when configured. */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  @OnEvent(DELIVERY_ATTENTION)
  onAttention(e: DeliveryAttentionEvent): void {
    this.logger.error(
      `delivery needs attention deliveryId=${e.deliveryId} attempts=${e.attempts}`,
    );
    if (this.cfg.sentryDsn) {
      Sentry.captureMessage('delivery needs attention', {
        level: 'error',
        extra: { ...e },
      });
    }
  }
}
