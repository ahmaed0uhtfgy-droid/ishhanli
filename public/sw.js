// Service Worker: استقبال إشعارات Push (FCM) وعرضها. مفيش تخزين مؤقت للملفات (عشان التحديثات تظهر فوراً).
// fetch: للتنقّل بين الصفحات بس — الشبكة دايماً الأول (من غير أي كاش)، ولو مفيش نت بنعرض صفحة «مفيش اتصال» بدل شاشة المتصفح البيضاء. باقي الطلبات (API/ملفات) بتعدّي زي ما هي. وجود المعالج ده كمان بيخلّي التثبيت كتطبيق يشتغل على كل المتصفحات.
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

const OFFLINE = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اشحنلي</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:3rem 1.5rem;background:#F7F4EC;color:#173B48"><h1>مفيش اتصال بالإنترنت</h1><p>اتأكد من النت وجرّب تاني.</p><p><button onclick="location.reload()" style="font:inherit;padding:.7rem 1.6rem;border:0;border-radius:.6rem;background:#173B48;color:#fff">إعادة المحاولة</button></p></body></html>';
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // مش بنلمس أي طلب غير تنقّل الصفحات
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});
