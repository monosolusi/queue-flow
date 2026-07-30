import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
// Single-host offline deployment: the caller is a static PWA served by NGINX
// at /caller in production; NGINX also proxies /api -> core-api and /ws ->
// core-api. In dev, the Vite server proxies those same paths to core-api on
// port 3000, so the app uses relative `/api` and `/ws` URLs in both
// environments (NFR-REL-01 — no remote calls).
export default defineConfig({
    plugins: [
        react(),
        VitePWA({
            registerType: 'autoUpdate',
            // The app is served under /caller behind NGINX; precache lives there.
            base: '/',
            includeAssets: ['favicon.svg'],
            manifest: {
                name: 'QMS Caller Panel',
                short_name: 'Caller',
                description: 'Counter staff queue workspace (offline)',
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
                // Precache the built bundle so the panel boots offline. Error pages
                // are handled by the app shell.
                navigateFallback: 'index.html',
            },
        }),
    ],
    server: {
        port: 3003,
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
