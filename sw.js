// Service worker: handles incoming push notifications and the
// "I'm on my way" action button, so a guardian can confirm without
// ever having to open the app itself.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = data.title || 'Emergency Alert';
  const options = {
    body: data.body || 'Someone needs help. Tap to confirm you are coming.',
    icon: undefined,
    tag: data.sosId ? ('sos-' + data.sosId) : 'sos-alert',
    requireInteraction: true,
    data: { sosId: data.sosId || null, mapUrl: data.mapUrl || null },
    actions: [
      { action: 'confirm', title: "I'm on my way" }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const sosId = event.notification.data && event.notification.data.sosId;
  event.notification.close();

  if (event.action === 'confirm' && sosId) {
    event.waitUntil(
      fetch('/api/sos-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sosId })
      })
        .then(() => self.registration.showNotification('Thanks!', {
          body: "They've been notified you're on your way.",
          tag: 'sos-confirmed-' + sosId
        }))
        .catch(() => {})
    );
  } else {
    // Default click (not the action button): open the confirm page
    // in case they want to see the map.
    const mapUrl = event.notification.data && event.notification.data.mapUrl;
    const url = sosId ? `/confirm.html?id=${sosId}` : '/';
    event.waitUntil(clients.openWindow(url));
  }
});

// ---------- Web Share Target ----------
// Registered via manifest.json's "share_target" entry. Once Ona is
// installed (added to home screen), it appears directly in the OS share
// sheet — e.g. sharing a meme from WhatsApp straight to "Ona" — rather
// than requiring someone to save the file first and then browse for it in
// a file picker. This is the actual point: no folder/thumbnail browsing at
// all, which is the part of manual upload that doesn't fit this persona
// well even though the file picker itself is screen-reader accessible.
//
// A static-hosted app can't handle a multipart POST on a plain page, so
// the browser's POST to /share-target has to be intercepted here: pull the
// shared file out of the form data, stash it somewhere index.html can read
// it from after the resulting redirect, then send the browser on to the
// app. Cache Storage is used as that hand-off spot — it's already
// available in a service worker with no extra library, and is built for
// storing exactly this shape of thing (a Request/Response pair).
const SHARE_CACHE_NAME = 'ona-shared-media';
const SHARE_CACHE_KEY = '/__shared-media-pending';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event.request));
  }
  // Every other request: fall through to the network as normal. This
  // service worker does no offline caching of app assets — it exists only
  // for push handling and this share-target hand-off.
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('mediaFile');

    if (file && typeof file.type === 'string') {
      const cache = await caches.open(SHARE_CACHE_NAME);
      await cache.put(
        SHARE_CACHE_KEY,
        new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } })
      );
    }
  } catch (err) {
    // If anything above fails, fall through to the redirect anyway —
    // index.html will simply find nothing waiting in the cache and behave
    // as if no file was shared, rather than getting stuck on this page.
  }

  // Share Target requires responding to the POST with a redirect/navigation
  // response; the app then reads the shared file back out of the cache.
  return Response.redirect('/?shared=1', 303);
}
