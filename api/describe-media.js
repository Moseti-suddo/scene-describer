import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Deliberately the SAME model already approved and running on this account
// for api/describe.js — this endpoint exists to give it a different job
// (general media/social-content understanding) via a different system
// prompt, not to introduce a second vendor. See project notes for why:
// Amazon Nova Lite was the original plan, but Vercel serverless functions
// enforce a hard 4.5MB request body limit at the platform level (not
// configurable), which made direct-POSTing raw video/image bytes at the
// sizes originally proposed infeasible without adding Vercel Blob or S3.
// Frame-sampling keeps payloads small enough to stay well under that limit
// using the exact same canvas-capture technique index.html already uses
// for the camera. Nova Lite remains the documented fallback if frame-based
// quality proves insufficient in testing — swapping it in later only means
// changing this file's model call, not the frontend contract.
const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const MAX_FRAMES = 10;
// Sanity ceiling per frame, enforced server-side even though the client is
// expected to compress before sending — defends against a misbehaving or
// modified client, not the normal path.
const MAX_FRAME_BASE64_CHARS = 2_000_000; // ~1.5MB decoded

// Separate, distinct persona from api/describe.js's BASE_SYSTEM_PROMPT.
// That prompt is tuned for physical-world navigation and safety; this one
// is tuned for understanding uploaded social/general media — memes,
// screenshots, photos, short videos — which calls for different judgment
// (explaining humor and context, not hazard-prioritizing spatial layout).
const MEDIA_SYSTEM_PROMPT =
  'You are helping a blind or low-vision person understand an image, meme, screenshot, or short video ' +
  'that they (or someone else) uploaded — this is general social/media content, not their physical surroundings. ' +
  'Speak plainly and directly, as if narrating out loud to them. ' +
  '\n\nYou may receive either a single image, or multiple images that are sequential frames sampled in order from ' +
  'a short video. If you receive multiple frames, treat them as a sequence and describe what happens over time — ' +
  'the flow of events, actions, and changes from start to end — rather than describing each frame individually ' +
  'or listing them one by one. For example: "The video starts with a man standing beside a car. He opens the ' +
  'driver\'s door and gets inside. A second person approaches and says something. The video ends with the car ' +
  'driving away." If you receive a single image, describe it as one photo or image, not a sequence. ' +
  '\n\nAlways cover, in natural spoken sentences rather than a rigid list: ' +
  'what is visually present (people, objects, setting, what people are doing); ' +
  'any visible text, read out in full and in reading order (for a meme, this usually means top text and bottom ' +
  'text, or a caption); ' +
  'and what the image or video appears to be communicating overall. ' +
  '\n\nIf this is clearly a meme, explain what it depicts, what the text means, and what the joke or point appears ' +
  'to be — but never claim to know the creator\'s actual intention. Hedge appropriately: say things like "the joke ' +
  'appears to be..." or "this seems to be poking fun at...", not "the creator meant...". If something is unclear or ' +
  'ambiguous, say so rather than guessing confidently. ' +
  '\n\nIf a spoken-audio transcript is provided separately, treat it as what was said in the video and weave it into ' +
  'the description naturally (e.g. "A voice says...") — do not treat it as on-screen text. ' +
  '\n\nDescribe only what is actually observable. Do not invent details, names, or context you cannot see or hear. ' +
  'Clearly distinguish plain observation from interpretation. ' +
  '\n\nKeep the response natural for spoken output: plain language, no walls of text, most important information ' +
  'first — but do not cut useful context just to be brief. A few sentences to a short paragraph is normal; go ' +
  'longer only if the content genuinely needs it (e.g. a multi-step video).' +
  '\n\nFor any follow-up question about this same media, answer that question directly and concisely, using the ' +
  'same media as context.';

const DEFAULT_QUESTION_TEXT = 'Describe this image or video in full, including any text, and explain what it appears to mean.';

async function runAnalysis({ client, mediaType, frames, audioTranscript, question }) {
  const content = frames.map(frameBase64 => ({
    image: { format: 'jpeg', source: { bytes: Buffer.from(frameBase64, 'base64') } }
  }));

  let questionText = question && question.trim() ? question.trim() : DEFAULT_QUESTION_TEXT;
  if (mediaType === 'video' && frames.length > 1 && !question) {
    questionText += ' These images are sequential frames sampled from a short video, in order.';
  }
  if (audioTranscript && audioTranscript.trim()) {
    questionText += `\n\nHere is a transcript of the spoken audio from this video: "${audioTranscript.trim()}"`;
  }

  content.push({ text: questionText });

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: MEDIA_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content }],
    inferenceConfig: {
      maxTokens: 800,
      temperature: 0.5
    }
  });

  const response = await client.send(command);
  const text = (response?.output?.message?.content?.[0]?.text || '').trim();
  if (!text) throw new Error('No response was returned');
  return text;
}

async function handleCreate(req, res) {
  try {
    // mediaType: 'image' | 'video'
    // frames: array of base64 JPEG strings — 1 for an image, several
    //         (client-sampled, in order) for a video. Always sent as
    //         compressed frames rather than raw file bytes, which is what
    //         keeps this endpoint well under Vercel's 4.5MB request body
    //         ceiling without needing Blob/S3.
    // audioTranscript: optional string, pre-transcribed client-side via the
    //         existing /api/transcribe (Groq Whisper) pipeline, for videos
    //         that have speech.
    // question: optional follow-up question. Empty/absent means "give the
    //         default full description." The client is expected to resend
    //         the same frames alongside a new question for follow-ups
    //         rather than this endpoint persisting frames server-side —
    //         keeps job records small and avoids storing media in KV.
    const { mediaType, frames, audioTranscript, question } = req.body || {};

    if (mediaType !== 'image' && mediaType !== 'video') {
      return res.status(400).json({ error: 'mediaType must be "image" or "video"' });
    }
    if (!Array.isArray(frames) || frames.length === 0) {
      return res.status(400).json({ error: 'Missing frames' });
    }
    if (frames.length > MAX_FRAMES) {
      return res.status(400).json({ error: `Too many frames (max ${MAX_FRAMES})` });
    }
    for (const f of frames) {
      if (typeof f !== 'string' || !f.length) {
        return res.status(400).json({ error: 'Invalid frame data' });
      }
      if (f.length > MAX_FRAME_BASE64_CHARS) {
        return res.status(400).json({ error: 'A frame is too large' });
      }
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

    const description = await runAnalysis({ client, mediaType, frames, audioTranscript, question });
    return res.status(200).json({ description });

  } catch (err) {
    console.error('describe-media-create error:', err);
    const detail = err && err.message ? err.message : 'Unknown server error';
    return res.status(500).json({ error: `Media analysis could not start: ${detail}` });
  }
}

export default async function handler(req, res) {
  if (req.method === 'POST') return handleCreate(req, res);
  if (req.method === 'GET') return res.status(405).json({ error: 'Status polling is not used for media analysis' });
  return res.status(405).json({ error: 'Method not allowed' });
}
