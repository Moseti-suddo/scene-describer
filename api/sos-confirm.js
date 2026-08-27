import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const key = `sos:${id}`;
    const record = await kv.get(key);
    if (!record) {
      return res.status(404).json({ error: 'Alert not found or has expired' });
    }

    record.status = 'confirmed';
    record.confirmedAt = Date.now();

    // Keep the same expiry window rather than resetting it.
    await kv.set(key, record, { ex: 6 * 60 * 60 });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('sos-confirm error:', err);
    return res.status(500).json({ error: 'Could not confirm the alert' });
  }
}
