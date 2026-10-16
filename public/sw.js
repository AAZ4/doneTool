'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'done', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Dein Essen ist fertig!', {
    body: data.body,
    tag: data.tag,
    renotify: true,
    requireInteraction: true,
    icon: '/icon.svg',
    badge: '/icon.svg',
    vibrate: [400, 150, 400, 150, 700],
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data.url;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => new URL(c.url).pathname === url);
    if (existing) return existing.focus();
    return self.clients.openWindow(url);
  })());
});
