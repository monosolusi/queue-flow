# syntax=docker/dockerfile:1
#
# admin-service — manager panel + first-run wizard PWA (Vite + React). Multi-
# stage: build the static bundle in node, then serve with nginx. The gateway
# proxies /admin/ here (and the root / redirects to /admin/) and strips the
# prefix, so nginx serves at root with an SPA fallback. Built with Vite
# `base: '/admin/'` so asset URLs are /admin/assets/... and the PWA
# start_url/scope are /admin/ (matches the NGINX route; NFR-REL-01 — offline).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80