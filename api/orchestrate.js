import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Intent categories from AI Orchestration spec, Section 2.
// GENERAL is the deliberate escape hatch (spec Section 13/19): if the
// model isn't confident, it must say so rather than guess — especially
// for anything that could route to Safety or Human Connection.
const VALID_INTENTS = [
  'SAFETY',
  'UNDERSTAND',
  'NAVIGATE',
  'HUMAN_CONNECTION',
  'NEED_HELP',
  'NEED_SOMEONE',
  'GENERAL'
];

// This endpoint is a fallback ONLY — the frontend's deterministic keyword
// matching (EMERGENCY_KEYWORDS, NAVIGATE_KEYWORDS, etc. in index.html)
// always runs first and handles the common, well-known phrasings directly,
// per spec Section 21 ("do not add AI simply because AI is available").
// This is only reached when nothing in that keyword chain matched —
// i.e. genuinely ambiguous or naturally-phrased speech.
//
// Priority order below mirrors spec Section 3 exactly: explicit emergency
// beats immediate physical safety beats navigation beats human connection.
// This is encoded as *instruction text*, not application logic — the
// actual routing/dispatch still happens client-side against the returned
// intent, per Section 16 ("existing features must remain the source of
// truth" — this endpoint classifies, it never acts).
const SYSTEM_PROMPT =
  'You are the intent classifier for AuraSense, an accessibility app for a blind or low-vision user. ' +
  'A voice transcript did not match any of the app\'s known command phrases, so you must classify what ' +
  'the person needs. You do not perform any action yourself — you only classify. ' +
  '\n\nReturn ONLY a single JSON object, with no preamble, no markdown fences, and no explanation. ' +
  'The JSON object must have exactly these fields:\n' +
  '{\n' +
  '  "intent": one of "SAFETY", "UNDERSTAND", "NAVIGATE", "HUMAN_CONNECTION", "NEED_HELP", "NEED_SOMEONE", "GENERAL",\n' +
  '  "confidence": a number from 0 to 1,\n' +
  '  "extractedEntity": a short string (e.g. a person\'s name or a destination) if the phrase names one, otherwise null,\n' +
  '  "needsConfirmation": true or false,\n' +
  '  "confirmationText": a short spoken confirmation question if needsConfirmation is true, otherwise null,\n' +
  '  "clarifyQuestion": a short spoken clarification question if intent is "GENERAL" or confidence is low, otherwise null\n' +
  '}\n' +
  '\nIntent definitions and priority (highest to lowest — if a phrase could plausibly mean more than one, pick the higher-priority one):\n' +
  '1. SAFETY — explicit emergency language ("emergency", "help me", "call for help"), OR immediate physical ' +
  'danger in the moment ("there\'s a car coming", "is something dangerous ahead", "help me avoid this"). ' +
  'Never require confirmation for SAFETY — it must act immediately.\n' +
  '2. NAVIGATE — the person wants to go somewhere, know where they are, or get walking directions. ' +
  'Extract the destination into extractedEntity if one is named.\n' +
  '3. UNDERSTAND — the person wants to know what is around them, wants text read aloud, or is asking who is nearby.\n' +
  '4. HUMAN_CONNECTION — the person wants to reach a specific named person (e.g. "call Sarah" — extract the ' +
  'name into extractedEntity) or find a community/interest group. This always needsConfirmation for calling/messaging ' +
  'a specific person, since it is a consequential action (spec Section 10) — set confirmationText to something like ' +
  '"Call Sarah?".\n' +
  '5. NEED_HELP — a general, non-specific request for help where the category of help is unclear ' +
  '("I need help", "can you help me").\n' +
  '6. NEED_SOMEONE — the person wants to talk to a person but has not specified who ' +
  '("I need someone", "I want to talk to someone", "I need support") — NOT the same as NEED_HELP; use this ' +
  'specifically when the need is clearly about human contact rather than an unspecified problem.\n' +
  '7. GENERAL — anything that does not clearly fit above, or where you are genuinely uncertain. Always set a ' +
  'clarifyQuestion in this case. Never guess at SAFETY, HUMAN_CONNECTION, or NAVIGATE if unsure — fall back to GENERAL.\n' +
  '\nImportant: do not diagnose emotional states, and do not treat emotional language ("I\'m overwhelmed", ' +
  '"something doesn\'t feel right") as an automatic mental-health crisis — route it to NEED_SOMEONE or NEED_HELP ' +
  'and let the app\'s existing flows ask what kind of support they want, rather than assuming.\n' +
  '\nKeep confirmationText and clarifyQuestion short, plain, spoken sentences — no more than one short sentence each.';

function buildContextNote(context) {
  // Session-only context (spec Section 6), never persisted — this
  // function only ever reads what's already in the request body, and
  // nothing here is written anywhere. See Section 8: context should not
  // become surveillance.
  if (!context || typeof context !== 'object') return '';

  const parts = [];
  if (context.currentTab) parts.push(`They are currently on the "${context.currentTab}" screen.`);
  if (context.assistanceMode) parts.push(`Their assistance mode is set to "${context.assistanceMode}".`);
  if (context.hasActiveRoute) {
    parts.push(
      context.activeRouteDestination
        ? `They are currently navigating to "${context.activeRouteDestination}".`
        : 'They are currently in the middle of an active navigation session.'
    );
  }
  if (context.hasEmergencyContact === false) parts.push('They have not yet set an emergency contact.');

  if (!parts.length) return '';
  return '\n\nCurrent app context (use this to disambiguate, e.g. "what\'s ahead" during navigation likely means NAVIGATE, not UNDERSTAND): ' + parts.join(' ');
}

// Safe fallback used whenever the model's output can't be trusted as-is —
// per spec Section 19, a failure to understand must say so plainly, never
// silently guess or default to acting.
function safeFallback(clarifyText) {
  return {
    intent: 'GENERAL',
    confidence: 0,
    extractedEntity: null,
    needsConfirmation: false,
    confirmationText: null,
    clarifyQuestion:
      clarifyText ||
      "I didn't understand that. You can ask me to describe your surroundings, navigate somewhere, contact someone, or get support."
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // text: the transcribed speech that didn't match any known keyword.
    // context: small, session-only snapshot of app state (see spec
    //          Section 6) — never a transcript history, never stored.
    const { text, context } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Missing text' });
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

    const systemPrompt = SYSTEM_PROMPT + buildContextNote(context);

    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [
        { role: 'user', content: [{ text: text.trim() }] }
      ],
      inferenceConfig: {
        // Classification only, not conversation — keep this small and
        // deterministic-leaning rather than expressive.
        maxTokens: 250,
        temperature: 0.2
      }
    });

    const response = await client.send(command);
    const raw = (response?.output?.message?.content?.[0]?.text || '').trim();

    if (!raw) {
      return res.status(200).json(safeFallback());
    }

    // The model is instructed to return raw JSON only, but strip fences
    // defensively in case it wraps the object in ```json anyway.
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('orchestrate: failed to parse model output as JSON:', raw);
      return res.status(200).json(safeFallback());
    }

    // Validate rather than trust — never forward an intent string the
    // frontend doesn't know how to switch on, and never forward a
    // confidently-wrong SAFETY/HUMAN_CONNECTION/NAVIGATE result missing
    // its required fields.
    if (!VALID_INTENTS.includes(parsed.intent)) {
      return res.status(200).json(safeFallback());
    }

    const result = {
      intent: parsed.intent,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      extractedEntity: typeof parsed.extractedEntity === 'string' ? parsed.extractedEntity : null,
      needsConfirmation: !!parsed.needsConfirmation,
      confirmationText: typeof parsed.confirmationText === 'string' ? parsed.confirmationText : null,
      clarifyQuestion: typeof parsed.clarifyQuestion === 'string' ? parsed.clarifyQuestion : null
    };

    // Low-confidence non-GENERAL results get downgraded to GENERAL with a
    // clarification question, rather than letting the frontend act on a
    // guess — this is the Section 13 "never invent... safety events" rule
    // applied at the boundary, not just in the prompt.
    if (result.intent !== 'GENERAL' && result.intent !== 'SAFETY' && result.confidence < 0.5) {
      return res.status(200).json(
        safeFallback(result.clarifyQuestion || 'What would you like help with?')
      );
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('orchestrate error:', err);
    const detail = err && err.name ? `${err.name}: ${err.message || ''}`.trim() : (err && err.message) || 'Unknown error';
    // Even on a hard failure, return a usable, honest fallback rather than
    // a bare 500 — the frontend can speak this directly per spec Section 19.
    return res.status(200).json(safeFallback());
  }
}