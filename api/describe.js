import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Everything the model needs to know about *how* to respond lives here now,
// in a real system prompt (Bedrock's Converse API supports a dedicated
// `system` field, separate from the conversation turns). This replaces the
// old approach of jamming a default-description string or a "keep it short"
// note directly into user-turn text.
//
// Covers four behaviors in one place:
//   1. Default: describe the scene, prioritizing what matters for
//      independence and safety over an exhaustive object inventory.
//   2. Reading mode: if the user's words suggest they want visible text
//      read aloud (a sign, label, document, screen, menu, etc.), transcribe
//      it verbatim instead of describing the scene. No keyword list needed —
//      Claude infers this from the transcribed question, in English,
//      Swahili, or code-switched phrasing.
//   3. Direct safety/hazard questions ("is it safe?", "are there stairs?"):
//      answer the specific question plainly first, then add only what's
//      relevant — not a full scene re-description.
//   4. Follow-ups: keep answers short, same spoken tone.
const BASE_SYSTEM_PROMPT =
  'You are helping a blind or low-vision person understand their surroundings through a phone camera, so they can move and act independently. ' +
  'Speak plainly and directly, as if narrating out loud to them — never say things like "this image shows" or "I see". ' +
  '\n\nIf the user asks you to read, or their words suggest they want visible text read aloud (a sign, label, document, screen, menu, etc.), ' +
  'transcribe that text verbatim, in natural reading order (top-to-bottom, left-to-right). ' +
  'If no readable text is visible, say so plainly rather than guessing or describing the scene instead. ' +
  '\n\nIf the user asks a direct safety question (e.g. "is it safe to continue?", "are there stairs?", "anything I should be careful about?"), ' +
  'answer that question first and plainly — a clear yes/no or hazard confirmation — then add only the detail needed to act on it. ' +
  'Do not pad this into a full scene description unless they ask for one. ' +
  '\n\nOtherwise, for a default or general description, prioritize what is useful for independence and safety over listing every object you notice. ' +
  'In rough order of priority: immediate hazards (steps, curbs, obstacles in the path, open doors, spills, uneven ground); ' +
  'moving things (people, vehicles, anything approaching); then useful fixed landmarks (doors and entrances, stairs, crossings, signs, seating, tables). ' +
  'Only mention something if it is actually present — never list a category just to be thorough. ' +
  'Give spatial relationships concretely: a direction (left, right, ahead, behind) and an approximate distance (e.g. "about two meters ahead"), ' +
  'rather than vague terms like "nearby" or "in the area". ' +
  'Keep the default description to 2-4 short spoken sentences. If there is no specific question, give this default description. ' +
  'If the user asks for more detail or asks what else is around, go beyond the priority items above and describe more of the scene, ' +
  'still concretely and still in plain spoken sentences. ' +
  '\n\nFor any other follow-up question, keep the answer short (1-3 sentences) and just as direct and concrete.';

// Assistance mode: a user preference (set in Settings or by voice command)
// controlling verbosity and tone, layered on top of the base behavior
// above rather than replacing it. This is the "confidence-building
// guidance" piece — the same underlying description/reading behavior,
// delivered at the pace and level of detail the user actually wants,
// rather than the app deciding that for them.
const MODE_INSTRUCTIONS = {
  independent:
    'The user has chosen Independent mode: they want minimal spoken output and prefer to rely on their own judgment. ' +
    'Only mention what is actionable or a genuine hazard (obstacles, steps, open doors, spills, moving people or vehicles in their path). ' +
    'Skip ambient detail, atmosphere, and anything not immediately useful. Keep answers as short as possible — often a single short sentence. ' +
    'Do not add reassurance or check-ins; they did not ask for that.',
  guided:
    'The user has chosen Guided mode (the default, balanced mode): give a full, clear description or reading as normal. ' +
    'Phrase things as help being available rather than assuming they want everything narrated at once — for example, ' +
    'mention what is ahead and offer to continue or add detail, rather than dumping every detail unprompted. ' +
    'Keep the tone plain and direct, not overly cautious.',
  support:
    'The user has chosen Support mode: they want a slower, steadier pace with more context, for an unfamiliar or overwhelming moment. ' +
    'Give a bit more context than usual and describe things progressively rather than all at once — it is fine to mention one or two ' +
    'things now and note there is more if they want it. Use a warm, calm tone, but stay natural and direct — not clinical, not saccharine, ' +
    'and never imply you are providing therapy or emotional counseling. A brief, genuine check-in is fine (e.g. "Let me know if you want more detail"), ' +
    'but keep it light and infrequent rather than in every response.'
};

function buildSystemPrompt(mode) {
  const modeInstruction = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.guided;
  return `${BASE_SYSTEM_PROMPT}\n\n${modeInstruction}`;
}

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
    // mode: the user's assistance-mode preference ('independent' | 'guided'
    //       | 'support'), read client-side from localStorage. Defaults to
    //       'guided' if missing or unrecognized.
    const { image, history, question, mode } = req.body;

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
      system: [{ text: buildSystemPrompt(mode) }],
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
