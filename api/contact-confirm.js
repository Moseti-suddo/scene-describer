import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { owner, subscription } = req.body || {};
    if (!owner || !subscription) {
      return res.status(400).json({ error: 'Missing owner or subscription' });
    }

    const key = `contact:${owner}`;
    const record = await kv.get(key);
    if (!record) {
      return res.status(404).json({ error: 'No pending contact found for this link' });
    }

    record.confirmed = true;
    record.subscription = subscription;
    record.confirmedAt = Date.now();

    await kv.set(key, record);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('contact-confirm error:', err);
    return res.status(500).json({ error: 'Could not confirm the contact' });
  }
}
