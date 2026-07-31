# syntax=docker/dockerfile:1
#
# core-api-service — NestJS backend (Clean Architecture). Multi-stage build:
# install + compile in the build stage, then a slim runtime with prod deps only.
# The Domain layer stays framework/ORM/IO-free (NFR-MNT-01) — `pg` is a prod dep
# but only ever imported under src/infrastructure (dep-cruiser enforced).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
# NFR-REL-03: the container self-heals — docker-compose restart: always.
CMD ["node", "dist/main.js"]