import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { unlockAudioOnFirstTap } from './sound';
import { UiProvider } from './ui';
import { registerSW } from 'virtual:pwa-register';

unlockAudioOnFirstTap();

// Keep the installed app up to date. Android rarely restarts an installed app, so without this a phone
// can keep running an old version for days. Check for a new version whenever the app comes back to the
// screen (and hourly); when one is ready it takes over and the page reloads itself (autoUpdate).
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    const check = () => {
      if (navigator.onLine) reg.update().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    setInterval(check, 60 * 60 * 1000);
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>,
);
