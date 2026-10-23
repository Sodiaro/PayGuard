# syntax=docker/dockerfile:1

ARG NODE_VERSION=24.19

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall generates the Prisma client; this stage also serves the compose migrate job.
RUN npm ci
COPY . .
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
# Scripts are skipped because the generated client is already compiled into dist/.
# --omit=optional drops the Prisma CLI and TypeScript, which npm keeps as optional peers of @prisma/client.
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
