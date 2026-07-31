# syntax=docker/dockerfile:1
#
# tv-display-service — TV queue board PWA (Vite + React) with the offline audio
# sequencer. Multi-stage: build the static bundle (incl. vendored MP3s in
# public/audio) in node, then serve with nginx. The gateway proxies /tv/ here
# and strips the prefix, so nginx serves at root. Built with Vite
# `base: '/tv/'` so asset + audio fragment URLs are /tv/... and the PWA
# start_url/scope are /tv/ (matches the NGINX route; NFR-REL-01 — fully offline).

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