# syntax=docker/dockerfile:1
#
# kiosk-service — visitor touchscreen PWA (Vite + React). Multi-stage: build
# the static bundle in node, then serve it with nginx. The gateway proxies
# /kiosk/ here and strips the prefix (proxy_pass trailing slash), so this
# nginx serves at root with an SPA fallback. Built with Vite `base: '/kiosk/'`
# so asset URLs are /kiosk/assets/... and the PWA start_url/scope are /kiosk/
# (matches the NGINX route; NFR-REL-01 — fully offline, no remote calls).

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