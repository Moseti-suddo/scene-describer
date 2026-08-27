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
