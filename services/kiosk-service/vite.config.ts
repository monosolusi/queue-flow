import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Single-host offline deployment: the kiosk is a static PWA served by NGINX
// at /kiosk in production; NGINX also proxies /api -> core-api. In dev, the
// Vite server proxies /api to core-api on port 3000, so the app uses relative
// `/api` URLs in both environments (NFR-REL-01 — no remote calls). The kiosk
// does not consume the WebSocket surface in QUE-17 (it is a ticket-issuing
// device, not a queue monitor — SRP), so only /api is proxied; /ws is left
// available for a future use without per-service config.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The app is served under /kiosk behind NGINX; precache lives there.
      base: '/',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'QMS Kiosk',
        short_name: 'Kiosk',
        description: 'Visitor ticket kiosk (offline)',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        scope: '/',
      },
      devOptions: {
        enabled: false,
      },
      workbox: {
        // Precache the built bundle so the kiosk boots offline. Error pages
        // are handled by the app shell.
        navigateFallback: 'index.html',
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