# syntax=docker/dockerfile:1

# Multi-stage build. Each stage is a separate image; only the last one ships,
# so build tooling and source never reach production.

# ---- deps -------------------------------------------------------------------
# Split from the build stage so that editing source does not invalidate the
# dependency layer — the single biggest win in day-to-day rebuild time.
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml carries the release-age exclusions and build approvals;
# without it a frozen install rejects packages the lockfile already pins.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Never bake secrets in here: anything present at build time is recoverable
# from the image layers. Runtime configuration arrives via env at `docker run`.
ENV NEXT_TELEMETRY_DISABLED=1
# Standalone output is Docker-only (next.config.ts). The check fails the build
# if the Agent SDK's native CLI is missing from it, or if source was traced in,
# instead of shipping an image whose every bot turn fails.
ENV OPENDOTS_STANDALONE=1
RUN pnpm build && node scripts/check-standalone.mjs

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
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
# No public/ directory: the only static asset (src/app/icon.svg) is built into
# .next. Add `COPY --from=build … /app/public ./public` back if one appears.

# Migrations run from the app on first use; they are read from ./db at runtime.
COPY --from=build --chown=nextjs:nodejs /app/db ./db

# OPENDOTS_DATA_DIR: bot workspaces and the bots' own configuration live
# outside the app tree so a volume can hold them. Created and chowned here
# because nextjs cannot mkdir under /.
RUN mkdir -p /data && chown nextjs:nodejs /data

USER nextjs
EXPOSE 3000

# /api/health reads the database and probes Ollama with a 1.5 s timeout, so it
# answers inside the 3 s limit even when Ollama is not running.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
