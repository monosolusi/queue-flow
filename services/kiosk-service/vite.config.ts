import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Single-host offline deployment: the kiosk is a static PWA served by NGINX
// at /kiosk/ in production; NGINX also proxies /api -> core-api. In dev, the
// Vite server proxies /api to core-api on port 3000, so the app uses relative
// `/api` URLs in both environments (NFR-REL-01 — no remote calls). The kiosk
// does not consume the WebSocket surface in QUE-17 (it is a ticket-issuing
// device, not a queue monitor — SRP), so only /api is proxied; /ws is left
// available for a future use without per-service config.
//
// Served under /kiosk/ behind NGINX: Vite `base: '/kiosk/'` makes the built
// assets reference `/kiosk/assets/...`, and the PWA `start_url`/`scope` are
// `/kiosk/` so an installed PWA launches at the kiosk route (the BrowserRouter
// `basename` in main.tsx matches) — aligns the CLAUDE.md latent gap.
export default defineConfig({
  base: '/kiosk/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'QMS Kiosk',
        short_name: 'Kiosk',
        description: 'Visitor ticket kiosk (offline)',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/kiosk/',
        scope: '/kiosk/',
      },
      devOptions: {
        enabled: false,
      },
      workbox: {
        // Precache the built bundle so the kiosk boots offline. Error pages
        // are handled by the app shell.
        navigateFallback: '/kiosk/index.html',
      },
    }),
  ],
  server: {
    port: 3001,
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