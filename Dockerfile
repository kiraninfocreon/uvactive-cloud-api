# ── Build stage ──────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# openssl is required by Prisma's query engine at generate/runtime
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate

COPY --from=build /app/dist ./dist

EXPOSE 8080
# Run pending migrations, THEN start. Previously ran bare
# `prisma migrate deploy` here on every container start — safe with
# one replica, but this service autoscales, and two containers booting
# together race on the SAME shared Postgres DB that branch-portal and
# admin-panel's backends also migrate against (see
# scripts/migrate-deploy-locked.cjs, added there for exactly this
# reason but never wired in here). Routed through the same advisory-
# lock wrapper so a concurrent boot waits its turn instead of racing
# into a P3009-blocked migrations table.
COPY scripts ./scripts

# Single DO App Platform / droplet instance now serves Admin, Branch,
# Trainer and Member traffic (SERVICE_SCOPE=all, see main.ts). One
# instance can't race itself on the advisory-locked migration step, but
# the wrapper stays — it's what makes a redeploy or a future second
# instance safe too, at zero extra cost today.
#
# NOTE: nest build emits to dist/src/main.js (sourceRoot: "src" in
# nest-cli.json), not dist/main.js — this previously pointed at the
# wrong path and would have failed to boot the container.
CMD ["sh", "-c", "node scripts/migrate-deploy-locked.cjs && node dist/src/main.js"]
