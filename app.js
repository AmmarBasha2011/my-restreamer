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

const downloadVideo = async (yt, videoId, destDir) => {
  try {
    console.log(`[youtubei.js] Fetching info for: ${videoId}`);
    const info = await yt.getInfo(videoId).catch(err => {
      if (err.message.includes('Type mismatch')) {
        console.warn(`[youtubei.js] Warning: Parser type mismatch for ${videoId}, attempting getBasicInfo.`);
        return yt.getBasicInfo(videoId);
      }
      throw err;
    });
    const title = (info.basic_info?.title || videoId).replace(/[\\/:*?"<>|]/g, '_');
    const filename = `${title}.mp4`;
    const outputPath = path.join(destDir, filename);

    console.log(`[youtubei.js] Starting download: ${filename}`);
    const stream = await info.download({
      type: 'video+audio',
      quality: 'best',
      format: 'mp4'
    });

    const fileStream = fs.createWriteStream(outputPath);
    Readable.fromWeb(stream).pipe(fileStream);

    return new Promise((resolve, reject) => {
      fileStream.on('finish', () => {
        console.log(`[youtubei.js] Download finished successfully: ${filename}`);
        resolve();
      });
      fileStream.on('error', (err) => {
        console.error(`[youtubei.js] File stream error for ${videoId}:`, err.message);
        reject(err);
      });
    });
  } catch (err) {
    console.error(`[youtubei.js] Error downloading video ${videoId}:`, err.message);
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
    // Provide JS evaluator for deciphering
    Platform.shim.eval = (code, env) => {
      const runtime = new Jinter(code);
      runtime.scope = env;
      return runtime.evaluate();
    };

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
