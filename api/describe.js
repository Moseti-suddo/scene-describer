import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'Missing image data' });
    }

    // These live only as environment variables on Vercel.
    // The browser never sees them.
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || 'us-east-1';

    if (!accessKeyId || !secretAccessKey) {
      return res.status(500).json({ error: 'Server is missing its AWS credentials configuration' });
    }

    const client = new BedrockRuntimeClient({
      region,
      credentials: { accessKeyId, secretAccessKey }
    });

    // Bedrock's Converse API wants raw base64 bytes, not a data URL.
    const imageBytes = Buffer.from(image, 'base64');

    const command = new ConverseCommand({
      modelId: MODEL_ID,
      messages: [
        {
          role: 'user',
          content: [
            {
              image: {
                format: 'jpeg',
                source: { bytes: imageBytes }
              }
            },
            {
              text: 'You are helping a blind or low-vision person understand their surroundings. Describe this scene in 2-4 short spoken sentences. Prioritize: what the space is, key objects and their approximate position (left, right, ahead), any people, and anything that could be a hazard (steps, obstacles, open doors, spills). Skip filler like "this image shows". Speak plainly and directly, as if narrating out loud to the person.'
            }
          ]
        }
      ],
      inferenceConfig: {
        maxTokens: 1000,
        temperature: 0.5
      }
    });

    const response = await client.send(command);
    const text = (response?.output?.message?.content?.[0]?.text || '').trim();

    if (!text) {
      return res.status(502).json({ error: 'No description was returned' });
    }

    return res.status(200).json({ description: text });

  } catch (err) {
    console.error('Bedrock error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server' });
  }
}
