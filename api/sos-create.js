import { kv } from '@vercel/kv';
import { randomUUID } from 'crypto';
import webpush from 'web-push';

const VAPID_PUBLIC_KEY = 'BJrLyoUXmrDsDf4xroOldzo3WztOkKdUuPGGpXhpnI9F7rNuSzVyLYg2Rpqmv5DxbsNLJITpejrswNukDTtwgL4';

function configureWebPush() {
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:example@example.com';
  if (!privateKey) return false;
  webpush.setVapidDetails(subject, VAPID_PUBLIC_KEY, privateKey);
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { lat, lng, owner } = req.body || {};
    const id = randomUUID();

    const record = {
      status: 'pending',
      lat: typeof lat === 'number' ? lat : null,
      lng: typeof lng === 'number' ? lng : null,
      createdAt: Date.now(),
      confirmedAt: null
    };

    // Alerts expire after 6 hours so old ones don't linger forever.
    await kv.set(`sos:${id}`, record, { ex: 6 * 60 * 60 });

    // Best-effort push notification to a confirmed emergency contact.
    // This never blocks or fails the alert itself — SMS (sent separately
    // by the front end) remains the guaranteed fallback channel.
    let pushSent = false;
    if (owner) {
      try {
        const contact = await kv.get(`contact:${owner}`);
        if (contact && contact.confirmed && contact.subscription && configureWebPush()) {
          const mapUrl = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : null;
          const payload = JSON.stringify({
            title: 'Emergency Alert',
            body: 'Your emergency contact needs help. Tap to confirm you are coming.',
            sosId: id,
            mapUrl
          });
          await webpush.sendNotification(contact.subscription, payload);
          pushSent = true;
        }
      } catch (pushErr) {
        console.error('Push send failed (non-fatal):', pushErr);
      }
    }

    return res.status(200).json({ id, pushSent });
  } catch (err) {
    console.error('sos-create error:', err);
    return res.status(500).json({ error: 'Could not create the alert' });
  }
}

