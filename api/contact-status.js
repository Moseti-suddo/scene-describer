import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { owner } = req.query;
    if (!owner) {
      return res.status(400).json({ error: 'Missing owner' });
    }

    const record = await kv.get(`contact:${owner}`);
    if (!record) {
      return res.status(200).json({ confirmed: false, exists: false });
    }

    // Never return the raw push subscription to the caller.
    return res.status(200).json({
      exists: true,
      confirmed: !!record.confirmed,
      phone: record.phone
    });
  } catch (err) {
    console.error('contact-status error:', err);
    return res.status(500).json({ error: 'Could not check the contact' });
  }
}
