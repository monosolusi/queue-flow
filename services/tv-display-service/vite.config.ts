import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Single-host offline deployment: the TV board is a static PWA served by
// NGINX at /tv/ in production; NGINX also proxies /api -> core-api and /ws ->
// core-api. In dev, the Vite server proxies those same paths to core-api on
// port 3000, so the app uses relative `/api` and `/ws` URLs in both
// environments (NFR-REL-01 — no remote calls). Like admin-service, the TV is
// scaffolded with the correct sub-path base from the start: Vite
// `base: '/tv/'` makes the built assets reference `/tv/assets/...` and the
// vendored audio fragments resolve to `/tv/audio/*.mp3` (via `import.meta.env.
// BASE_URL`), and the PWA `start_url`/`scope` are `/tv/` so an installed PWA
// launches at the TV route. The BrowserRouter `basename` in main.tsx matches.
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
        // Precache the built bundle + the vendored audio MP3s so the TV boots
        // and announces fully offline (NFR-REL-01).
        navigateFallback: '/tv/index.html',
        globPatterns: ['**/*.{js,css,html,mp3,webmanifest,svg}'],
      },
    }),
  ],
  server: {
    port: 3002,
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