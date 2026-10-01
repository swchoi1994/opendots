# syntax=docker/dockerfile:1

# Multi-stage build. Each stage is a separate image; only the last one ships,
# so build tooling and source never reach production.

# ---- deps -------------------------------------------------------------------
# Split from the build stage so that editing source does not invalidate the
# dependency layer — the single biggest win in day-to-day rebuild time.
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Never bake secrets in here: anything present at build time is recoverable
# from the image layers. Runtime configuration arrives via env at `docker run`.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runtime ----------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user. The standalone output is owned by root by default, so
# ownership is set during COPY rather than with a later chown layer.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Bot workspaces (the Agent SDK cwd) live outside the app tree so a volume can
# hold them. Created and chowned here because nextjs cannot mkdir under /data.
RUN mkdir -p /data/workspaces && chown nextjs:nodejs /data/workspaces

USER nextjs
EXPOSE 3000

# The health endpoint already exists and touches no external service, so it
# reports "process is up" without falsely depending on Postgres or Redis.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
