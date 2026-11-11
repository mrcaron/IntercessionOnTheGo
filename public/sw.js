// Service worker for the intercessor's dashboard: shows push alerts and opens
// the dashboard when one is tapped. It caches nothing.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let body = 'Something new is waiting.';
  try {
    body = event.data.json().body || body;
  } catch {
    /* keep the default */
  }
  event.waitUntil(
    self.registration.showNotification('Prayer Station', {
      body,
      tag: 'prayer-station',
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).pathname.startsWith('/dash'));
      if (open) return open.focus();
      return self.clients.openWindow('/dash');
    })(),
  );
});
