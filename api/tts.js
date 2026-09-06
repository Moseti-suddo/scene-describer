// Text-to-speech via ElevenLabs, used only when the user's preferred
// language is Swahili — the browser's built-in speechSynthesis already
// handles English fine on essentially every device, and Amazon Polly (the
// only other TTS vendor already in this project's AWS account) has no
// Swahili voice at all, so this is a genuinely new dependency, not a
// redundant one.
//
// This endpoint is intentionally generic (just "text in, mp3 out") rather
// than Swahili-specific — ElevenLabs' multilingual models read whatever
// language the text is written in, so the language selection actually
// happens client-side (only calling this endpoint when preferredLanguage
// is 'sw') rather than being a parameter here.
//
// Model choice: eleven_flash_v2_5 (~75ms model inference) rather than the
// higher-quality eleven_multilingual_v2, because this is used mid-
// conversation (scene descriptions, hazard checks, nav steps) where
// responsiveness matters more than the last bit of vocal expressiveness —
// especially on the slower mobile connections this app is built for.
const ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Missing text' });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server is missing its ElevenLabs API key configuration' });
    }

    // No default guessed here on purpose — an incorrect hardcoded voice ID
    // would fail in a more confusing way (a 404 deep in ElevenLabs' API)
    // than just asking for this to be configured explicitly. Pick a voice
    // from the ElevenLabs voice library (one that reads Swahili well) and
    // set its ID as this env var.
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!voiceId) {
      return res.status(500).json({ error: 'Server is missing its ElevenLabs voice ID configuration' });
    }

    const elevenResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text.trim(),
        model_id: ELEVENLABS_MODEL_ID
      })
    });

    if (!elevenResponse.ok) {
      let detail = `HTTP ${elevenResponse.status}`;
      try {
        const errBody = await elevenResponse.json();
        detail = errBody?.detail?.message || errBody?.detail || detail;
      } catch (e) {
        // Body wasn't JSON — stick with the status code.
      }
      console.error('ElevenLabs TTS error:', detail);
      return res.status(502).json({ error: `Text-to-speech request failed (${detail})` });
    }

    const audioBuffer = Buffer.from(await elevenResponse.arrayBuffer());

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audioBuffer);

  } catch (err) {
    console.error('tts error:', err);
    return res.status(500).json({ error: 'Something went wrong generating speech' });
  }
}
