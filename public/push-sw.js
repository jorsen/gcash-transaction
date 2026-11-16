/* Push notification handlers, imported into the generated service worker (see vite.config.ts). */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'GCash Tracker', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    Promise.all([
      // Tell any open app window to refresh its lists right away (realtime).
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((list) => list.forEach((c) => c.postMessage({ type: 'push-received', tag: data.tag }))),
      self.registration.showNotification(data.title || 'GCash Tracker', {
        body: data.body || '',
        icon: '/pwa-192x192.png',
        badge: '/pwa-64x64.png',
        tag: data.tag,
        renotify: Boolean(data.tag),
        data: { url: data.url || '/' },
        requireInteraction: Boolean(data.sticky),
        vibrate: [200, 100, 200],
        timestamp: Date.now(),
      }),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          // Let the open app navigate itself (keeps its login state and avoids a reload).
          client.postMessage({ type: 'open-url', url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The browser can rotate or expire a push subscription. Re-subscribe and tell the server right away
// (cookies are sent, so it's linked to whoever is logged in) so notifications keep working while the app is closed.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        let key = event.oldSubscription?.options?.applicationServerKey;
        if (!key) {
          const res = await fetch('/api/push/key', { credentials: 'same-origin' });
          if (!res.ok) return;
          const { publicKey } = await res.json();
          const padded = (publicKey + '='.repeat((4 - (publicKey.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
          key = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
        }
        const sub = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        await fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });
      } catch (e) {
        // Next time the app is opened it re-registers anyway.
      }
    })(),
  );
});
