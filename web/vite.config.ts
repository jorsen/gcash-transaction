import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base so the build works on any host or sub-path (GitHub Pages, Netlify, EAS Hosting...).
  base: './',
  server: {
    host: true, // reachable from a phone on the same Wi-Fi during development
    fs: { allow: ['..'] }, // the receipt parser is shared with the native app in ../src/lib
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'GCash Tracker',
        short_name: 'GCash Tracker',
        description: 'Record GCash transactions by capturing or uploading receipts.',
        theme_color: '#007DFE',
        background_color: '#F3F6FB',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        globIgnores: ['**/icon.png'], // 1024px source icon, only used to generate the others
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
