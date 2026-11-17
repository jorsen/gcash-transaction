import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { apiDevPlugin } from './dev/apiDevPlugin';

export default defineConfig({
  base: '/',
  server: {
    host: true, // reachable from a phone on the same Wi-Fi during development
  },
  plugins: [
    react(),
    apiDevPlugin(), // dev only: serves /api with an embedded Postgres
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'GCash Tracker',
        short_name: 'GCash Tracker',
        description: 'Record GCash transactions by capturing or uploading receipts.',
        theme_color: '#0a6cff',
        background_color: '#f2f5fa',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Lets the installed app appear in Android's "Share via" sheet (e.g. right after sending in GCash).
        // The service worker (public/push-sw.js) receives the image and opens the attach screen.
        share_target: {
          action: '/share-receipt',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            files: [{ name: 'receipt', accept: ['image/*', '.png', '.jpg', '.jpeg', '.webp'] }],
          },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // Push notification handlers (public/push-sw.js).
        importScripts: ['push-sw.js'],
        // Never answer API calls from the offline cache.
        navigateFallbackDenylist: [/^\/api\//],
        globIgnores: ['**/logo.svg'], // source for the generated icons
        // Cache the OCR engine and English language data after first use so scanning works offline.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-assets',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
