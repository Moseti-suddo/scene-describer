import { kv } from '@vercel/kv';

// If a job has been "pending" longer than this, the create-endpoint
// invocation almost certainly crashed or hit its maxDuration without
// reaching its own catch block (e.g. a hard timeout kill) — report a
// timeout rather than letting the frontend poll forever. This value should
// stay comfortably below describe-media-create's maxDuration in vercel.json.
const STALE_PENDING_MS = 55 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const record = await kv.get(`mediaJob:${id}`);
    if (!record) {
      return res.status(404).json({ status: 'not_found' });
    }

    if (record.status === 'pending' && (Date.now() - record.createdAt) > STALE_PENDING_MS) {
      return res.status(200).json({
        status: 'error',
        error: 'Analysis is taking too long. Please try again with a shorter clip.'
      });
    }

    return res.status(200).json({
      status: record.status,
      description: record.description || null,
      error: record.error || null
    });
  } catch (err) {
    console.error('describe-media-status error:', err);
    return res.status(500).json({ error: 'Could not check the analysis status' });
  }
}
