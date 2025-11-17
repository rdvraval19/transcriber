// api/transcribe.js
const Busboy = require('busboy');
const FormData = require('form-data');

let fetchLib = global.fetch;
try {
  if (!fetchLib) fetchLib = require('node-fetch');
} catch (e) {
  // node-fetch might not be installed locally; Vercel provides fetch in many runtimes
}

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      console.error('Missing OPENAI_API_KEY');
      return res.status(500).json({ error: 'Server misconfigured: OPENAI_API_KEY missing' });
    }

    const busboy = new Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES } });
    let uploadedBuffer = null;
    let uploadedFilename = 'upload.mp4';
    let instaUrl = '';

    await new Promise((resolve, reject) => {
      let aborted = false;
      busboy.on('file', (fieldname, fileStream, info) => {
        const chunks = [];
        uploadedFilename = (info && info.filename) ? info.filename : uploadedFilename;
        fileStream.on('data', (d) => chunks.push(d));
        fileStream.on('limit', () => {
          aborted = true;
          reject(new Error('File upload exceeded limit of ' + MAX_BYTES + ' bytes'));
        });
        fileStream.on('end', () => { if (!aborted) uploadedBuffer = Buffer.concat(chunks); });
        fileStream.on('error', (err) => reject(err));
      });

      busboy.on('field', (name, val) => { if (name === 'insta_url') instaUrl = val; });
      busboy.on('finish', () => resolve());
      busboy.on('error', (err) => reject(err));
      req.pipe(busboy);
    });

    let mediaBuffer = uploadedBuffer;
    if (!mediaBuffer && instaUrl) {
      console.log('Fetching Instagram page:', instaUrl);
      if (!fetchLib) {
        console.error('fetch is not available; install node-fetch');
        return res.status(500).json({ error: 'Server misconfigured: fetch not available' });
      }
      const pageResp = await fetchLib(instaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!pageResp.ok) {
        const txt = await pageResp.text().catch(()=>'');
        console.error('Failed fetching Instagram page', pageResp.status, txt.slice(0,300));
        return res.status(400).json({ error: 'Failed to fetch Instagram page; ensure URL is public' });
      }
      const html = await pageResp.text();

      const ogMatch = html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i);
      let videoUrl = ogMatch ? ogMatch[1] : null;

      if (!videoUrl) {
        const jsonMatch = html.match(/window\._sharedData\s*=\s*(\{.*?\});/s);
        if (jsonMatch) {
          try {
            const jsData = JSON.parse(jsonMatch[1]);
            const media = jsData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
            if (media && media.video_url) videoUrl = media.video_url;
          } catch (e) {
            console.warn('Could not parse _sharedData JSON:', e.message);
          }
        }
      }

      if (!videoUrl) {
        console.error('Could not find og:video or video_url in Instagram page');
        return res.status(400).json({ error: 'Cannot find direct video URL. Make sure reel is public or upload MP4.' });
      }

      const vresp = await fetchLib(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!vresp.ok) {
        console.error('Failed to download video URL', videoUrl, vresp.status);
        return res.status(502).json({ error: 'Failed to download video from Instagram' });
      }
      const arr = await vresp.arrayBuffer();
      if (arr.byteLength > MAX_BYTES) {
        return res.status(400).json({ error: 'Downloaded media exceeds size limit' });
      }
      mediaBuffer = Buffer.from(arr);
      uploadedFilename = 'reel.mp4';
    }

    if (!mediaBuffer) return res.status(400).json({ error: 'No media provided — upload a file or provide insta_url' });

    const form = new FormData();
    form.append('file', mediaBuffer, { filename: uploadedFilename });
    form.append('model', 'whisper-1');
    form.append('translate', 'true'); // request translation to English
    form.append('language', 'hi');

    const openaiResp = await fetchLib('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form
    });

    if (!openaiResp.ok) {
      const bodyText = await openaiResp.text().catch(() => '');
      console.error('OpenAI transcription failed:', openaiResp.status, bodyText);
      return res.status(502).json({ error: 'Transcription provider error', status: openaiResp.status, body: bodyText });
    }

    const j = await openaiResp.json();
    const transcript = j.text || j.transcript || JSON.stringify(j);
    return res.json({ transcript });
  } catch (err) {
    console.error('Unhandled error in transcribe function:', err && err.stack ? err.stack : String(err));
    return res.status(500).json({ error: 'Internal server error', detail: String(err.message || err) });
  }
};
