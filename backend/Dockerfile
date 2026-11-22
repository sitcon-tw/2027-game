# Build from the repository root for Linux amd64.
FROM --platform=linux/amd64 node:26-bookworm-slim@sha256:18a166e2d50578afe933434857ed2d9059bd1aa398a223e9c89eb4302354f079 AS node-base

FROM node-base AS gateway-build
WORKDIR /app/gateway
# Only Prisma's build-time tooling needs the system OpenSSL library.
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY backend/gateway/package.json backend/gateway/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/gateway/prisma/schema.prisma ./prisma/
RUN npm run generate
COPY backend/gateway/*.ts backend/gateway/tsconfig.json ./
COPY backend/gateway/game/ ./game/
COPY backend/gateway/game-api/ ./game-api/
RUN npm run typecheck && npm prune --omit=dev --no-audit --no-fund

FROM node-base
ENV NODE_ENV=production PORT=8787
WORKDIR /app/gateway
COPY --from=gateway-build /app/gateway/node_modules/ ./node_modules/
COPY --from=gateway-build /app/gateway/build/ ./build/
COPY --from=gateway-build /app/gateway/package.json ./
COPY --from=gateway-build /app/gateway/*.ts ./
COPY --from=gateway-build /app/gateway/game/ ./game/
COPY --from=gateway-build /app/gateway/game-api/ ./game-api/
USER 10001:10001
EXPOSE 8787/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "/app/gateway/healthcheck.ts"]
ENTRYPOINT ["node", "/app/gateway/main.ts"]
