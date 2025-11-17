// api/transcribe.js
// Minimal Vercel serverless function to accept an uploaded file or an Instagram URL,
// download the media if needed, and send it to OpenAI Whisper (audio transcription).
// Requires: process.env.OPENAI_API_KEY set in Vercel environment variables.

const Busboy = require('busboy');
const FormData = require('form-data');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    // Parse multipart/form-data with Busboy
    const busboy = new Busboy({ headers: req.headers });
    let uploadedBuffer = null;
    let uploadedFilename = 'upload.mp4';
    let instaUrl = '';

    await new Promise((resolve, reject) => {
      busboy.on('file', (fieldname, fileStream, info) => {
        const chunks = [];
        uploadedFilename = info && info.filename ? info.filename : uploadedFilename;
        fileStream.on('data', (d) => chunks.push(d));
        fileStream.on('end', () => {
          uploadedBuffer = Buffer.concat(chunks);
        });
        fileStream.on('error', (err) => reject(err));
      });

      busboy.on('field', (name, val) => {
        if (name === 'insta_url') instaUrl = val;
      });

      busboy.on('finish', resolve);
      busboy.on('error', reject);

      req.pipe(busboy);
    });

    // If no uploaded file but an Instagram URL is provided, try to fetch the video
    let mediaBuffer = uploadedBuffer;
    if (!mediaBuffer && instaUrl) {
      // fetch the instagram page and try to parse og:video meta tag
      const pageResp = await fetch(instaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!pageResp.ok) return res.status(400).json({ error: 'Failed to fetch Instagram page (is the URL public?)' });
      const html = await pageResp.text();

      // Try to find <meta property="og:video" content="...">
      const ogMatch = html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i);
      let videoUrl = ogMatch ? ogMatch[1] : null;

      // Best-effort fallback: try to find video_url in JSON embedded on the page
      if (!videoUrl) {
        const jsonMatch = html.match(/window\._sharedData\s*=\s*(\{.*?\});/s);
        if (jsonMatch) {
          try {
            const jsData = JSON.parse(jsonMatch[1]);
            const media = jsData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
            if (media && media.video_url) videoUrl = media.video_url;
          } catch (e) {
            // ignore JSON parse issues
          }
        }
      }

      if (!videoUrl) {
        return res.status(400).json({ error: 'Cannot find direct video URL on the Instagram page. Make sure the reel is public.' });
      }

      const vresp = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!vresp.ok) return res.status(502).json({ error: 'Failed to download video from Instagram' });
      mediaBuffer = Buffer.from(await vresp.arrayBuffer());
      uploadedFilename = 'reel.mp4';
    }

    if (!mediaBuffer) {
      return res.status(400).json({ error: 'No media provided. Upload a file or provide insta_url.' });
    }

    // Send to OpenAI Whisper (audio transcription). Requires OPENAI_API_KEY in env
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured in environment' });

    // Build multipart/form-data to OpenAI
    const form = new FormData();
    form.append('file', mediaBuffer, { filename: uploadedFilename });
    form.append('model', 'whisper-1');     // model name
    form.append('translate', 'true');      // request translation to English
    form.append('language', 'hi');         // hint that source language is Hindi

    const openaiResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        // note: do NOT set Content-Type manually when using form-data
      },
      body: form
    });

    if (!openaiResp.ok) {
      const errTxt = await openaiResp.text();
      return res.status(502).json({ error: 'Transcription provider error: ' + errTxt });
    }

    const j = await openaiResp.json();
    const transcript = j.text || j.transcript || JSON.stringify(j);

    return res.json({ transcript });
  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).json({ error: String(err) });
  }
};
