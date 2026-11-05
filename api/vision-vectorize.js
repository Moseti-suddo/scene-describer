export const config = {
  api: {
    bodyParser: {
      sizeLimit: '6mb'
    }
  }
};

const API_VERSION = '2024-02-01';
const DEFAULT_MODEL_VERSION = '2023-04-15';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Missing image data' });
    }

    const endpoint = (process.env.AZURE_VISION_ENDPOINT || '').replace(/\/+$/, '');
    const key = process.env.AZURE_VISION_KEY;
    const modelVersion = process.env.AZURE_VISION_MODEL_VERSION || DEFAULT_MODEL_VERSION;

    if (!endpoint || !key) {
      return res.status(500).json({ error: 'Server is missing its Azure Vision configuration' });
    }

    const imageBytes = Buffer.from(image, 'base64');
    if (!imageBytes.length) {
      return res.status(400).json({ error: 'Image data is invalid' });
    }

    const params = new URLSearchParams({
      'api-version': API_VERSION,
      'model-version': modelVersion
    });

    const response = await fetch(
      `${endpoint}/computervision/retrieval:vectorizeImage?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'Ocp-Apim-Subscription-Key': key
        },
        body: imageBytes
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.vector) || data.vector.length === 0) {
      console.error('Azure Vision vectorization error:', response.status, data?.error || data);
      return res.status(502).json({
        error: 'Azure Vision could not vectorize this image',
        status: response.status
      });
    }

    return res.status(200).json({
      vector: data.vector,
      modelVersion: data.modelVersion || modelVersion
    });
  } catch (err) {
    console.error('vision-vectorize error:', err);
    return res.status(500).json({ error: 'Something went wrong vectorizing the image' });
  }
}
