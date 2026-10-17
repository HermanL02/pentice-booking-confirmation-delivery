import { PubSub } from '@google-cloud/pubsub';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
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

/** Closes the client after every module (the consumer included) is destroyed. */
@Injectable()
export class PubSubClientLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(PubSubClientLifecycle.name);

  constructor(@Inject(PUBSUB_CLIENT) private readonly pubsub: PubSub | null) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.pubsub?.close();
    } catch (err) {
      this.logger.error(`closing pub/sub client failed: ${String(err)}`);
    }
  }
}
