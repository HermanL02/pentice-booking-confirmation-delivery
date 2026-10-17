import { registerAs, type ConfigType } from '@nestjs/config';

export const pubsubConfig = registerAs('pubsub', () => ({
  enabled: Boolean(process.env.PUBSUB_EMULATOR_HOST),
  emulatorHost: process.env.PUBSUB_EMULATOR_HOST,
  projectId: process.env.GCP_PROJECT_ID as string,
  topic: process.env.PUBSUB_TOPIC as string,
  subscription: process.env.PUBSUB_SUBSCRIPTION as string,
}));

export type PubSubConfig = ConfigType<typeof pubsubConfig>;
