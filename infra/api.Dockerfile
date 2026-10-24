# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @familyhub/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @familyhub/api db:generate && pnpm --filter @familyhub/api build
RUN pnpm --filter @familyhub/api deploy --prod /out && cp -r apps/api/dist apps/api/prisma /out/ \
  && cd /out && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /out ./
RUN mkdir -p /data/uploads && chown app:app /data/uploads
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma && node dist/server.js"]
