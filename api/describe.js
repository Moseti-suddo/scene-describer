import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const DEFAULT_DESCRIBE_PROMPT =
  'You are helping a blind or low-vision person understand their surroundings. ' +
  'Describe this scene in 2-4 short spoken sentences. Prioritize: what the space is, ' +
  'key objects and their approximate position (left, right, ahead), any people, and ' +
  'anything that could be a hazard (steps, obstacles, open doors, spills). Skip filler ' +
  'like "this image shows". Speak plainly and directly, as if narrating out loud to the person.';

const FOLLOW_UP_SYSTEM_NOTE =
  'Keep answering as if speaking out loud to a blind or low-vision person. ' +
  'Keep answers short (1-3 sentences) and direct.';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // image: base64 jpeg of the photo being discussed (always sent, so the
    //        backend stays stateless between requests).
    // history: prior turns of this conversation, in order, as
    //          [{ role: 'user' | 'assistant', text: '...' }, ...]. Empty/absent
    //          on the very first turn.
    // question: the new thing the user just said. Empty/absent means
    //           "give me the default fresh description".
    const { image, history, question } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'Missing image data' });
    }

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

    const imageBytes = Buffer.from(image, 'base64');
    const priorTurns = Array.isArray(history) ? history : [];

    // Cap how much history we carry to keep payloads (and cost) bounded.
    const MAX_TURNS = 12;
    const trimmedHistory = priorTurns.slice(-MAX_TURNS);

    const messages = [];

    if (trimmedHistory.length === 0) {
      // First turn: attach the image alongside either the user's own
      // question ("what colour is my shirt") or the default scene prompt.
      messages.push({
        role: 'user',
        content: [
          { image: { format: 'jpeg', source: { bytes: imageBytes } } },
          { text: question && question.trim() ? question.trim() : DEFAULT_DESCRIBE_PROMPT }
        ]
      });
    } else {
      // Reconstruct the conversation. The image only needs to be attached
      // once, on the first user turn, since it's part of the same request's
      // message history each time (the API itself is stateless between calls).
      trimmedHistory.forEach((turn, i) => {
        if (i === 0 && turn.role === 'user') {
          messages.push({
            role: 'user',
            content: [
              { image: { format: 'jpeg', source: { bytes: imageBytes } } },
              { text: turn.text }
            ]
          });
        } else {
          messages.push({ role: turn.role, content: [{ text: turn.text }] });
        }
      });

      messages.push({
        role: 'user',
        content: [{ text: `${FOLLOW_UP_SYSTEM_NOTE}\n\nQuestion: ${question}` }]
      });
    }

    const command = new ConverseCommand({
      modelId: MODEL_ID,
      messages,
      inferenceConfig: {
        maxTokens: 700,
        temperature: 0.5
      }
    });

    const response = await client.send(command);
    const text = (response?.output?.message?.content?.[0]?.text || '').trim();

    if (!text) {
      return res.status(502).json({ error: 'No response was returned' });
    }

    return res.status(200).json({ description: text });

  } catch (err) {
    console.error('Bedrock error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server' });
  }
}
