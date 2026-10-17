/**
 * Creates the topic and subscription on a running Pub/Sub emulator. Idempotent.
 *   pnpm emulator:setup
 */
import { PubSub } from '@google-cloud/pubsub';

const ALREADY_EXISTS = 6;

function ignoreAlreadyExists(err: unknown): void {
  if ((err as { code?: unknown } | null)?.code !== ALREADY_EXISTS) throw err;
}

/** Names default to the env, then to the same defaults as the app config. */
export async function setupPubSubEmulator(
  names: { topic?: string; subscription?: string } = {},
): Promise<void> {
  process.env.PUBSUB_EMULATOR_HOST ??= 'localhost:8085';
  const projectId = process.env.GCP_PROJECT_ID ?? 'booking-local';
  const topic =
    names.topic ?? process.env.PUBSUB_TOPIC ?? 'confirmation-deliveries';
  const subscription =
    names.subscription ??
    process.env.PUBSUB_SUBSCRIPTION ??
    'confirmation-deliveries-sub';

  const pubsub = new PubSub({ projectId });
  try {
    await pubsub.createTopic(topic).catch(ignoreAlreadyExists);
    await pubsub
      .topic(topic)
      .createSubscription(subscription, { ackDeadlineSeconds: 60 })
      .catch(ignoreAlreadyExists);
  } finally {
    await pubsub.close();
  }
}

if (require.main === module) {
  setupPubSubEmulator().then(
    () => console.log('pub/sub emulator topic and subscription ready'),
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
