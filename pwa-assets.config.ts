import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Generates the app icons in public/ from the native app's icon. Run: npm run icons
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: minimal2023Preset,
  images: ["public/icon.png"],
});
