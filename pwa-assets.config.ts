import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Generates the app icons in public/ from public/logo.svg. Run: npm run icons
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    // Maskable/Apple icons get padding; fill it with the brand blue instead of white.
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: '#0a6cff' } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background: '#0a6cff' } },
  },
  images: ['public/logo.svg'],
});
