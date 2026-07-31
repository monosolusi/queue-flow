# syntax=docker/dockerfile:1
#
# caller-service — counter staff PWA (Vite + React). Multi-stage: build the
# static bundle in node, then serve with nginx. The gateway proxies /caller/
# here and strips the prefix, so nginx serves at root with an SPA fallback.
# Built with Vite `base: '/caller/'` so asset URLs are /caller/assets/... and
# the PWA start_url/scope are /caller/ (matches the NGINX route; NFR-REL-01).

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