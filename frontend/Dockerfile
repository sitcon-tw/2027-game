# Build with frontend/ as the context. Official Node 26 Debian slim, Linux amd64 manifest.
FROM --platform=linux/amd64 node:26-bookworm-slim@sha256:18a166e2d50578afe933434857ed2d9059bd1aa398a223e9c89eb4302354f079 AS base
WORKDIR /app
ENV NODE_ENV=production PORT=4173 NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY next.config.mjs ./
COPY app/ ./app/
COPY public/ ./public/
RUN npm run build

FROM base
COPY --from=build --chown=node:node /app/node_modules ./node_modules/
COPY --from=build --chown=node:node /app/.next ./.next/
COPY --chown=node:node package.json next.config.mjs server.mjs healthcheck.mjs ./
COPY --chown=node:node app/routes.js ./app/routes.js
COPY --chown=node:node public/ ./public/
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["node", "server.mjs"]
