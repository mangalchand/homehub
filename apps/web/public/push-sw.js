/* Imported into the generated service worker: shows Web Push notifications and opens the app on tap. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'FamilyHub', body: event.data && event.data.text() }; }
  const title = data.title || 'FamilyHub';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      vibrate: [120, 60, 120],
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) { w.navigate(url).catch(() => undefined); return w.focus(); }
      }
      return self.clients.openWindow(url);
    }),
  );
});
