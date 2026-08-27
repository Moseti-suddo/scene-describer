export const config = {
  api: {
    bodyParser: {
      // Short voice clips only (a few seconds of audio) — keep this well
      // under Vercel's request body limit.
      sizeLimit: '10mb'
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // audio: base64-encoded recording of what the user just said.
    // mimeType: the MediaRecorder mime type it was captured with
    //           (e.g. 'audio/webm'), so we can give Whisper the right hint.
    const { audio, mimeType } = req.body;

    if (!audio) {
      return res.status(400).json({ error: 'Missing audio data' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server is missing its Groq API key configuration' });
    }

    const audioBytes = Buffer.from(audio, 'base64');
    const extension = (mimeType && mimeType.includes('mp4')) ? 'mp4' : 'webm';

    const form = new FormData();
    form.append('file', new Blob([audioBytes], { type: mimeType || 'audio/webm' }), `speech.${extension}`);
    form.append('model', 'whisper-large-v3-turbo');
    // Left without a fixed "language" on purpose: this app's users
    // code-switch between English and Swahili, and Whisper's own language
    // detection handles that better than forcing a single language.
    form.append('response_format', 'json');

    const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      console.error('Groq transcription error:', data);
      return res.status(502).json({ error: data?.error?.message || 'Transcription failed' });
    }

    const text = (data?.text || '').trim();
    return res.status(200).json({ text });

  } catch (err) {
    console.error('Transcribe error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server' });
  }
}
