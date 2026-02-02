import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { Innertube, UniversalCache, Platform } from 'youtubei.js';
import { Jinter } from 'jintr';
import { Readable } from 'stream';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// RapidAPI Configuration
const RAPIDAPI_KEY = '90e2561aefmshb1e09ecc9fe7ff0p1c02c6jsnc7805861cede';
const RAPIDAPI_HOST = 'yt-video-audio-downloader-api.p.rapidapi.com';
const RAPIDAPI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Provide JS evaluator for deciphering (Fix for youtubei.js + jintr)
Platform.shim.eval = (data, args) => {
  if (data.player_script) {
    const runtime = new Jinter();
    for (const [key, value] of Object.entries(args)) {
      runtime.scope.set(key, value);
    }
    return runtime.evaluate(data.player_script);
  }
  return data;
};

const app = express();
const PORT = process.env.PORT || 3000;

// --- FILE PATHS ---
const PLAYLISTS_DIR = path.join(__dirname, 'playlists');
const DESTINATIONS_FILE = path.join(__dirname, 'destinations.json');

// --- SETUP AND STATE MANAGEMENT ---
if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR);
if (!fs.existsSync(DESTINATIONS_FILE)) fs.writeFileSync(DESTINATIONS_FILE, '[]');

let destinations = JSON.parse(fs.readFileSync(DESTINATIONS_FILE, 'utf-8'));
const activeStreams = new Map(); // K: destinationId, V: ffmpegProcess

// Self-healing: Ensure playlist directories exist for all known destinations on startup
destinations.forEach(dest => {
  const destDir = path.join(PLAYLISTS_DIR, dest.id);
  if (!fs.existsSync(destDir)) {
    console.log(`[Startup] Playlist directory for '${dest.name}' not found. Creating: ${destDir}`);
    fs.mkdirSync(destDir, { recursive: true });
  }
});

// --- HELPER FUNCTIONS ---
const saveDestinations = () => {
  fs.writeFileSync(DESTINATIONS_FILE, JSON.stringify(destinations, null, 2));
};

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static('public'));

// --- MULTER STORAGE for per-destination uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const destDir = path.join(PLAYLISTS_DIR, req.params.id);
    if (!fs.existsSync(destDir)) {
      return cb(new Error('Destination playlist does not exist.'), false);
    }
    cb(null, destDir);
  },
  filename: (req, file, cb) => {
    cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8')); // Handle special characters
  }
});
const upload = multer({ storage: storage });

// --- API: DESTINATION & PLAYLIST MANAGEMENT ---

app.get('/api/destinations', (req, res) => {
  const fullDestinations = destinations.map(dest => {
    const destDir = path.join(PLAYLISTS_DIR, dest.id);
    const videos = fs.existsSync(destDir) ? fs.readdirSync(destDir).filter(f => !f.startsWith('.')) : [];
    return { ...dest, playlist: videos, isStreaming: activeStreams.has(dest.id) };
  });
  res.json(fullDestinations);
});

app.post('/api/destinations', (req, res) => {
  const { name, key } = req.body;
  if (!name || !key) return res.status(400).send('Name and Key are required.');
  
  const newDestination = { id: crypto.randomUUID(), name, key };
  destinations.push(newDestination);
  
  // Create a dedicated directory for this destination's playlist
  fs.mkdirSync(path.join(PLAYLISTS_DIR, newDestination.id));
  
saveDestinations();
  res.status(201).json(newDestination);
});

app.delete('/api/destinations/:id', (req, res) => {
  const { id } = req.params;
  if (activeStreams.has(id)) return res.status(400).send('Cannot delete with an active stream.');
  
  destinations = destinations.filter(d => d.id !== id);
  
  // Remove the associated playlist directory
  const destDir = path.join(PLAYLISTS_DIR, id);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  
saveDestinations();
  res.status(200).send('Destination and its playlist deleted.');
});

// --- API: Per-Destination Playlist Actions ---

app.post('/api/upload/:id', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ success: true, message: `Video '${req.file.originalname}' uploaded.` });
});

app.post('/api/playlist/clear/:id', (req, res) => {
  const { id } = req.params;
  if (activeStreams.has(id)) return res.status(400).send('Cannot clear playlist while stream is active.');
  
  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return res.status(404).send('Playlist not found.');

  fs.readdirSync(destDir).forEach(file => fs.unlinkSync(path.join(destDir, file)));
  res.status(200).send('Playlist cleared successfully.');
});

// --- API: STREAM CONTROL ---

const extractVideoId = (url) => {
  const match = url.match(/(?:v=|be\/|shorts\/)([0-9A-Za-z_-]{11})/);
  return match ? match[1] : null;
};

const extractPlaylistId = (url) => {
  const match = url.match(/[&?]list=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
};

// --- RAPIDAPI HELPERS ---

/**
 * Fetches video metadata using RapidAPI.
 */
async function fetchVideoInfo(url) {
  const response = await fetch(`https://${RAPIDAPI_HOST}/video_info`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key': RAPIDAPI_KEY,
      'User-Agent': RAPIDAPI_USER_AGENT
    },
    body: JSON.stringify({ url })
  });
  if (!response.ok) throw new Error(`RapidAPI video_info failed: ${response.statusText}`);
  return await response.json();
}

/**
 * Initiates a download job on RapidAPI.
 */
async function startDownloadJob(url, format = 'mp4', quality = 720) {
  const response = await fetch(`https://${RAPIDAPI_HOST}/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key': RAPIDAPI_KEY,
      'User-Agent': RAPIDAPI_USER_AGENT
    },
    body: JSON.stringify({ url, format, quality })
  });
  if (!response.ok) throw new Error(`RapidAPI download initiation failed: ${response.statusText}`);
  return await response.json();
}

/**
 * Polls the download job status until it is completed or fails.
 */
async function pollJobStatus(jobId) {
  const maxRetries = 60; // 5 minutes with 5s interval
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(`https://${RAPIDAPI_HOST}/status/${jobId}`, {
      headers: {
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY,
        'User-Agent': RAPIDAPI_USER_AGENT
      }
    });
    if (!response.ok) throw new Error(`RapidAPI status check failed: ${response.statusText}`);
    const data = await response.json();

    if (data.status === 'completed') return data;
    if (data.status === 'error') {
      console.error('[RapidAPI] Job Error Data:', JSON.stringify(data, null, 2));
      throw new Error(`RapidAPI job error: ${data.message || data.error || 'Unknown error'}`);
    }

    console.log(`[RapidAPI] Job ${jobId} status: ${data.status} (${data.progress || '0%'})`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error('RapidAPI job timed out.');
}

/**
 * Downloads the processed file from RapidAPI and saves it locally.
 */
async function downloadFinalFile(jobId, filename, outputPath) {
  const response = await fetch(`https://${RAPIDAPI_HOST}/file/${jobId}/${filename}`, {
    headers: {
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key': RAPIDAPI_KEY,
      'User-Agent': RAPIDAPI_USER_AGENT
    }
  });
  if (!response.ok) throw new Error(`RapidAPI file fetch failed: ${response.statusText}`);

  const fileStream = fs.createWriteStream(outputPath);
  const reader = Readable.fromWeb(response.body);
  reader.pipe(fileStream);

  return new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
}

/**
 * Orchestrates the video download process using RapidAPI with fallback.
 */
const downloadVideo = async (yt, videoId, destDir, format = 'mp4', quality = 720) => {
  try {
    await downloadVideoInternal(yt, videoId, destDir, format, quality);
  } catch (err) {
    if (quality !== 360 && (err.message.includes('empty') || err.message.includes('failed'))) {
      console.warn(`[RapidAPI] Download failed for ${quality}p, falling back to 360p for ${videoId}`);
      await downloadVideoInternal(yt, videoId, destDir, format, 360);
    } else {
      throw err;
    }
  }
};

/**
 * Internal orchestrator for RapidAPI download.
 */
const downloadVideoInternal = async (yt, videoId, destDir, format, quality) => {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    console.log(`[RapidAPI] Fetching info for: ${videoId}`);
    const info = await fetchVideoInfo(url);
    const title = (info.videoDetails?.title || info.title || videoId).replace(/[\\/:*?"<>|]/g, '_');
    const filename = `${title}.${format}`;
    const outputPath = path.join(destDir, filename);

    console.log(`[RapidAPI] Starting download job: ${title}`);
    const job = await startDownloadJob(url, format, quality);

    if (job.directDownload && job.downloadUrl) {
      console.log(`[RapidAPI] Direct download available for ${title}`);
      const response = await fetch(job.downloadUrl);
      if (!response.ok) throw new Error(`Direct download failed: ${response.statusText}`);
      const fileStream = fs.createWriteStream(outputPath);
      const reader = Readable.fromWeb(response.body);
      reader.pipe(fileStream);
      await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
    } else {
      console.log(`[RapidAPI] Job initiated: ${job.jobId}`);
      const completedJob = await pollJobStatus(job.jobId);
      console.log(`[RapidAPI] Job completed. Ready to fetch file.`);

      // Use the provided downloadUrl if it's a full URL, otherwise use the /file endpoint
      let downloadUrl = completedJob.downloadUrl;
      if (downloadUrl && (downloadUrl.startsWith('http://') || downloadUrl.startsWith('https://'))) {
          console.log(`[RapidAPI] Downloading from full URL: ${downloadUrl}`);
          const response = await fetch(downloadUrl);
          if (!response.ok) throw new Error(`File fetch from full URL failed: ${response.statusText}`);
          const fileStream = fs.createWriteStream(outputPath);
          const reader = Readable.fromWeb(response.body);
          reader.pipe(fileStream);
          await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
          });
      } else {
          // Fallback to our downloadFinalFile helper which uses the /v1/file endpoint
          await downloadFinalFile(job.jobId, completedJob.filename || `${videoId}.${format}`, outputPath);
      }
    }
    console.log(`[RapidAPI] Download finished successfully: ${filename}`);

  } catch (err) {
    console.error(`[RapidAPI] Error downloading video ${videoId}:`, err.message);
    throw err;
  }
};

app.post('/api/youtube/add/:id', async (req, res) => {
  const { id } = req.params;
  const { url } = req.body;
  console.log(`[API] Action: Add from YouTube | Destination ID: ${id} | URL: ${url}`);

  if (!url) return res.status(400).send('YouTube URL is required.');

  const videoId = extractVideoId(url);
  const playlistId = extractPlaylistId(url);

  if (!videoId && !playlistId) return res.status(400).send('Invalid YouTube URL.');

  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return res.status(404).send('Destination not found.');

  res.status(202).send('Download process started.');

  try {
    const yt = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_store: true,
      client: 'ANDROID'
    });

    if (playlistId) {
      console.log(`[youtubei.js] Fetching playlist: ${playlistId}`);
      const playlist = await yt.getPlaylist(playlistId);
      console.log(`[youtubei.js] Found ${playlist.videos.length} videos in playlist.`);

      for (const video of playlist.videos) {
        if (video.id) {
          try {
            await downloadVideo(yt, video.id, destDir);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting prevention
          } catch (e) {
            console.error(`[youtubei.js] Skipping video ${video.id} due to error: ${e.message}`);
          }
        }
      }
    } else {
      await downloadVideo(yt, videoId, destDir);
    }

  } catch (err) {
    console.error(`[youtubei.js] Error in download process for ${url}:`, err.message);
  }
});

app.post('/api/stream/start/:id', (req, res) => {
  const { id } = req.params;
  const dest = destinations.find(d => d.id === id);

  if (!dest) return res.status(404).send('Destination not found.');
  if (activeStreams.has(id)) return res.status(400).send('Stream is already running.');

  const destDir = path.join(PLAYLISTS_DIR, id);
  const videoFiles = fs.readdirSync(destDir).filter(f => !f.startsWith('.'));
  if (videoFiles.length === 0) return res.status(400).send('Playlist is empty.');

  const playlistFile = path.join(destDir, 'playlist.txt');
  const playlistContent = videoFiles.map(file => `file '${path.join(destDir, file)}'`).join('\n');
  fs.writeFileSync(playlistFile, playlistContent);

  const ffmpegArgs = [
    '-re', '-f', 'concat', '-safe', '0', '-stream_loop', '-1',
    '-i', playlistFile,
    '-c', 'copy', '-f', 'flv', `rtmp://a.rtmp.youtube.com/live2/${dest.key}`
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
  activeStreams.set(id, ffmpegProcess);

  ffmpegProcess.stderr.on('data', (data) => console.error(`[${dest.name}] ffmpeg: ${data}`));
  ffmpegProcess.on('close', (code) => {
    console.log(`[${dest.name}] stream stopped (code ${code})`);
    activeStreams.delete(id);
    if (fs.existsSync(playlistFile)) fs.unlinkSync(playlistFile); // Clean up playlist file
  });

  res.status(200).send(`Stream started for '${dest.name}'.`);
});

app.post('/api/stream/stop/:id', (req, res) => {
  const { id } = req.params;
  console.log(`[API] Action: Stop Stream | Destination ID: ${id}`);
  const process = activeStreams.get(id);

  if (process) {
    process.kill('SIGKILL');
    activeStreams.delete(id);
    res.status(200).send(`Stream stopped.`);
  } else {
    res.status(400).send('Stream not running.');
  }
});

// --- SERVER START ---
app.listen(PORT, () => {
  console.log(`Per-stream playlist Restreamer running on http://localhost:${PORT}`);
});
