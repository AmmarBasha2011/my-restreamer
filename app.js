const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

app.post('/api/youtube/add/:id', (req, res) => {
  const { id } = req.params;
  const { url } = req.body;
  console.log(`[API] Action: Add from YouTube | Destination ID: ${id} | URL: ${url}`);

  if (!url) return res.status(400).send('YouTube URL is required.');

  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return res.status(404).send('Destination not found.');

  // بناء الإعدادات النظيفة تماماً بدون كوكيز وبدون OAuth تالف
  const ytdlpArgs = [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', 
    '-o', path.join(destDir, '%(title)s.%(ext)s'), 
    
    // إجبار الأداة على استخدام مشغل أندرويد للهواتف (Android client لا يطلب كوكيز أو فحص بوتات للروابط العامة)
    '--extractor-args', 'youtube:player-client=android',
    '--user-agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    
    // إعدادات إضافية لتفادي الحظر الأمني للسيرفرات
    '--no-check-certificates',
    '--geo-bypass',
    '--sleep-requests', '1.5',
    '--no-warnings'
  ];

  console.log(`[yt-dlp] Starting 100% clean download with args: ${ytdlpArgs.join(' ')}`);
  const ytdlpProcess = spawn('yt-dlp', ytdlpArgs);

  ytdlpProcess.stdout.on('data', (data) => {
    console.log(`[yt-dlp] stdout: ${data}`);
  });

  ytdlpProcess.stderr.on('data', (data) => {
    console.error(`[yt-dlp] stderr: ${data}`);
  });

  ytdlpProcess.on('close', (code) => {
    if (code === 0) {
      console.log(`[yt-dlp] Download finished successfully for URL: ${url}`);
    } else {
      console.error(`[yt-dlp] Process exited with code ${code} for URL: ${url}`);
    }
  });

  res.status(202).send('Download started. The video will be added to the playlist shortly.');
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
