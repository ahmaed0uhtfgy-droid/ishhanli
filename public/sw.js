// Service Worker: استقبال إشعارات Push (FCM) وعرضها. مفيش تخزين مؤقت للملفات (عشان التحديثات تظهر فوراً).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { title: event.data ? event.data.text() : '' }; }
  const d = p.data || p.notification || p; // FCM بيغلّف الرسالة؛ بنقبل الشكلين
  event.waitUntil(self.registration.showNotification(d.title || 'اشحنلي', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: d.type === 'new_order' || d.type === 'sos', // طلب جديد/استغاثة: يفضل ظاهر لحد ما حد يتعامل معاه
    vibrate: [200, 100, 200],
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
    for (const c of list) {
      if (c.url.startsWith(self.location.origin)) { try { await c.navigate(url); } catch { /* ignore */ } return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
