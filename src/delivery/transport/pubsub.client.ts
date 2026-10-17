import { PubSub } from '@google-cloud/pubsub';
import type { Provider } from '@nestjs/common';
import { pubsubConfig, type PubSubConfig } from '../../config/pubsub.config';

/** `PubSub | null`: null unless PUBSUB_EMULATOR_HOST is set. */
export const PUBSUB_CLIENT = Symbol('PUBSUB_CLIENT');

export const pubsubClientProvider: Provider = {
  provide: PUBSUB_CLIENT,
  // The client reads PUBSUB_EMULATOR_HOST from the environment itself.
  useFactory: (cfg: PubSubConfig): PubSub | null =>
    cfg.enabled ? new PubSub({ projectId: cfg.projectId }) : null,
  inject: [pubsubConfig.KEY],
};
