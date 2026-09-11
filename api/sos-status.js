import { kv } from '@vercel/kv';

// Merged with the former api/sos-confirm.js into one file: GET checks an
// alert's status, POST confirms it — both operate on the same `sos:{id}`
// KV record, so this was a natural consolidation, and freed the function
// slot needed for api/describe-media.js under Vercel Hobby's 12-function
// cap. Callers of the old POST /api/sos-confirm (confirm.html, sw.js) now
// POST here instead.

async function handleGet(req, res) {
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
    console.error('sos-status GET error:', err);
    return res.status(500).json({ error: 'Could not check the alert' });
  }
}

async function handlePost(req, res) {
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
    console.error('sos-status POST (confirm) error:', err);
    return res.status(500).json({ error: 'Could not confirm the alert' });
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}
