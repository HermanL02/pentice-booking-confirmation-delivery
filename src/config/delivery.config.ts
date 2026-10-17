import { registerAs, type ConfigType } from '@nestjs/config';

export const deliveryConfig = registerAs('delivery', () => ({
  tickMs: Number(process.env.DELIVERY_TICK_MS),
  timeoutMs: Number(process.env.DELIVERY_TIMEOUT_MS),
  leaseMs: Number(process.env.DELIVERY_LEASE_MS),
  backoffBaseMs: Number(process.env.DELIVERY_BACKOFF_BASE_MS),
  backoffMaxMs: Number(process.env.DELIVERY_BACKOFF_MAX_MS),
  attentionAfterAttempts: Number(process.env.DELIVERY_ATTENTION_AFTER_ATTEMPTS),
  shutdownDrainMs: Number(process.env.SHUTDOWN_DRAIN_MS),
  guestDeviceInboxUrl: process.env.GUEST_DEVICE_INBOX_URL as string,
}));

export type DeliveryConfig = ConfigType<typeof deliveryConfig>;
