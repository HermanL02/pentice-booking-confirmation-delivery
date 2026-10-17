# syntax=docker/dockerfile:1

# ---- builder: install all dependencies, compile, then drop dev dependencies
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# --ignore-scripts: the `prepare` script runs `lefthook install`, which fails
# without a .git directory. No dependency needs a build script at runtime.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod --ignore-scripts

# ---- runtime: compiled app and production dependencies only, non-root
FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1001 nodejs \
  && useradd --uid 1001 --gid nodejs --shell /bin/sh --create-home nodejs

WORKDIR /app
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
# The outbox file lives here; mount a volume on /app/data to keep it across containers.
RUN mkdir -p /app/data && chown nodejs:nodejs /app/data

USER nodejs
ENV NODE_ENV=production PORT=3000 DATA_FILE=/app/data/store.json
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/main"]
