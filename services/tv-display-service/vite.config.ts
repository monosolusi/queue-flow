import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Single-host offline deployment: the TV board is a static PWA served by
// NGINX at /tv/ in production; NGINX also proxies /api -> core-api and /ws ->
// core-api. In dev, the Vite server proxies those same paths to core-api on
// port 3000, so the app uses relative `/api` and `/ws` URLs in both
// environments (NFR-REL-01 — no remote calls). Like admin-service, the TV is
// scaffolded with the correct sub-path base from the start: Vite
// `base: '/tv/'` makes the built assets reference `/tv/assets/...`, and the PWA
// `start_url`/`scope` are `/tv/` so an installed PWA launches at the TV route.
// The BrowserRouter `basename` in main.tsx matches. Announcement audio is NOT a
// bundled asset — it is fetched from tts-service at `/tts/announcement`, which is
// origin-relative and so unaffected by `base`.
export default defineConfig({
  base: '/tv/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'QMS TV Display',
        short_name: 'TV',
        description: 'TV queue board + offline audio announcements',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/tv/',
        scope: '/tv/',
      },
      devOptions: {
        enabled: false,
      },
      workbox: {
        // Precache the built bundle so the board still renders if it reloads
        // while core-api is restarting. Announcement audio is deliberately NOT
        // precached: the clip URL space is unbounded (every ticket number x
        // counter), and tts-service runs on the same local PC as core-api — if it
        // is unreachable the board has no data to announce either. Everything
        // precached here is local; nothing is fetched from the internet
        // (NFR-REL-01).
        navigateFallback: '/tv/index.html',
        globPatterns: ['**/*.{js,css,html,webmanifest}'],
      },
    }),
  ],
  server: {
    port: 3002,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
      // Announcement audio from tts-service. No `rewrite`: FastAPI mounts its
      // routes under /tts itself, exactly as the gateway's `location /tts/`
      // proxy_passes without a trailing slash — so the same URL works in dev and
      // in production.
      '/tts': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});