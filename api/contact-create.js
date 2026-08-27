import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { owner, phone } = req.body || {};
    if (!owner || !phone) {
      return res.status(400).json({ error: 'Missing owner or phone' });
    }

    const record = {
      phone,
      confirmed: false,
      subscription: null,
      createdAt: Date.now()
    };

    // No expiry: an emergency contact relationship should persist
    // until explicitly replaced.
    await kv.set(`contact:${owner}`, record);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('contact-create error:', err);
    return res.status(500).json({ error: 'Could not save the contact' });
  }
}
