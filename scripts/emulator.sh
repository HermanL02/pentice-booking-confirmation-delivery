#!/usr/bin/env bash
# Local Pub/Sub emulator for the optional Pub/Sub transport. Then: pnpm emulator:setup
set -euo pipefail
exec gcloud --quiet beta emulators pubsub start --host-port=localhost:8085 --project=booking-local
