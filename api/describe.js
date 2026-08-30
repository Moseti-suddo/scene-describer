import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Everything the model needs to know about *how* to respond lives here now,
// in a real system prompt (Bedrock's Converse API supports a dedicated
// `system` field, separate from the conversation turns). This replaces the
// old approach of jamming a default-description string or a "keep it short"
// note directly into user-turn text.
//
// Covers three behaviors in one place:
//   1. Default: describe the scene (used when there's no specific question)
//   2. Reading mode: if the user's words suggest they want visible text
//      read aloud (a sign, label, document, screen, menu, etc.), transcribe
//      it verbatim instead of describing the scene. No keyword list needed —
//      Claude infers this from the transcribed question, in English,
//      Swahili, or code-switched phrasing.
//   3. Follow-ups: keep answers short, same spoken tone.
const SYSTEM_PROMPT =
  'You are helping a blind or low-vision person understand their surroundings through a phone camera. ' +
  'Speak plainly and directly, as if narrating out loud to them — never say things like "this image shows" or "I see". ' +
  '\n\nIf the user asks you to read, or their words suggest they want visible text read aloud (a sign, label, document, screen, menu, etc.), ' +
  'transcribe that text verbatim, in natural reading order (top-to-bottom, left-to-right). ' +
  'If no readable text is visible, say so plainly rather than guessing or describing the scene instead. ' +
  '\n\nOtherwise, describe the scene in 2-4 short spoken sentences: what the space is, key objects and their approximate position ' +
  '(left, right, ahead), any people, and anything that could be a hazard (steps, obstacles, open doors, spills). ' +
  'If there is no specific question, give this default scene description. ' +
  '\n\nFor any follow-up question, keep the answer short (1-3 sentences) and just as direct.';

const DEFAULT_QUESTION_TEXT = 'Describe what is in front of me.';

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
    //           "give me the default fresh description" — the system prompt
    //           itself now handles that fallback behavior, so we just pass
    //           a plain placeholder through rather than swapping in a whole
    //           separate prompt string.
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
    const questionText = question && question.trim() ? question.trim() : DEFAULT_QUESTION_TEXT;

    if (trimmedHistory.length === 0) {
      // First turn: attach the image alongside whatever the user asked
      // (or the default placeholder). The system prompt above is what
      // decides whether this becomes a scene description or a text read-out.
      messages.push({
        role: 'user',
        content: [
          { image: { format: 'jpeg', source: { bytes: imageBytes } } },
          { text: questionText }
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

      // Plain follow-up text now — no more manually prepending a
      // "keep it short" note here, since that instruction lives in the
      // system prompt and applies throughout the whole conversation.
      messages.push({
        role: 'user',
        content: [{ text: questionText }]
      });
    }

    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
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
    const detail = err && err.name ? `${err.name}: ${err.message || ''}`.trim() : (err && err.message) || 'Unknown error';
    return res.status(500).json({ error: `Bedrock request failed (${detail})` });
  }
}
