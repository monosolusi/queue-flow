import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Single-host offline deployment: the admin panel is a static PWA served by
// NGINX at /admin/ in production; NGINX also proxies /api -> core-api and /ws ->
// core-api. In dev, the Vite server proxies those same paths to core-api on
// port 3000, so the app uses relative `/api` and `/ws` URLs in both
// environments (NFR-REL-01 — no remote calls).
//
// Unlike caller-service/kiosk-service (which use base '/' — a latent gap noted in
// CLAUDE.md), admin-service is scaffolded with the correct sub-path base from
// the start: Vite `base: '/admin/'` makes the built assets reference
// `/admin/assets/...`, and the PWA `start_url`/`scope` are `/admin/` so an
// installed PWA launches at the admin route, not the gateway root. The
// BrowserRouter `basename` in main.tsx matches.
export default defineConfig({
  base: '/admin/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'QMS Admin',
        short_name: 'Admin',
        description: 'Manager control panel + first-run wizard (offline)',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/admin/',
        scope: '/admin/',
      },
      devOptions: {
        enabled: false,
      },
      workbox: {
        // Precache the built bundle so the panel boots offline.
        navigateFallback: '/admin/index.html',
      },
    }),
  ],
  server: {
    port: 3004,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});