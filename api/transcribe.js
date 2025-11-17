// api/transcribe.js
const Busboy = require('busboy');
const FormData = require('form-data');

let fetchLib = global.fetch;
try {
  if (!fetchLib) fetchLib = require('node-fetch');
} catch (e) {
  // node-fetch may not be installed locally; Vercel often provides fetch in runtime
}

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB limit

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
        uploadedFilename = info && info.filename ? info.filename : uploadedFilename;
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
            const media = jsData?.entry_data?.PostPage?.[0]?._
