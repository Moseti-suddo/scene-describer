import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const record = await kv.get(`sos:${id}`);
    if (!record) {
      return res.status(404).json({ status: 'not_found' });
    }

    return res.status(200).json(record);
  } catch (err) {
    console.error('sos-status error:', err);
    return res.status(500).json({ error: 'Could not check the alert' });
  }
}
