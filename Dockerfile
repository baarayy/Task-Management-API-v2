# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Build tools for argon2's native binding.
RUN apk add --no-cache python3 make g++

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ── Production dependencies ───────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# dumb-init reaps zombies and forwards SIGTERM, which node as PID 1 does not -
# without it graceful shutdown never runs on a rolling deploy.
RUN apk add --no-cache dumb-init curl

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Never run as root.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
