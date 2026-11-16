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
