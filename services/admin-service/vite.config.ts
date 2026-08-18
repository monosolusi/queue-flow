import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Single-host offline deployment: the admin panel is a static PWA served by
// NGINX at /admin/ in production; NGINX also proxies /api -> core-api and /ws ->
// core-api. In dev, the Vite server proxies those same paths to core-api on
// port 3000, so the app uses relative `/api` and `/ws` URLs in both
// environments (NFR-REL-01 — no remote calls).
//
// All four frontends (admin/kiosk/tv/caller) are aligned to their gateway
// sub-path: Vite `base: '/admin/'` makes the built assets reference
// `/admin/assets/...`, the PWA `start_url`/`scope` are `/admin/` so an
// installed PWA launches at the admin route (not the gateway root), and the
// BrowserRouter `basename` in main.tsx matches. The gateway strips the
// prefix via its trailing-slash proxy_pass, so the per-service nginx serves
// the bundle at root and the prefixed asset URLs round-trip correctly.
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
      // `/tts-config`'s "Tes Suara" plays a clip straight from tts-service. In
      // production the gateway already proxies `/tts/`, so this entry only makes
      // dev match; without it the preview 404s against the Vite server and the
      // page looks broken on a developer machine only.
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