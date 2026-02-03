const express = require('express');
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


// --- API: DESTINATION & PLAYLIST MANAGEMENT ---

app.get('/api/destinations', (req, res) => {
  const fullDestinations = destinations.map(dest => {
    const destDir = path.join(PLAYLISTS_DIR, dest.id);
    const videos = fs.existsSync(destDir) ? fs.readdirSync(destDir).filter(f => !f.startsWith('.') && f !== 'playlist.txt') : [];
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

app.post('/api/file/add/:id', (req, res) => {
  const { id } = req.params;
  const { url } = req.body;

  if (!url) return res.status(400).send('URL is required.');
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return res.status(400).send('Invalid URL protocol. Only http and https are supported.');
  }

  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return res.status(404).send('Destination not found.');

  let filename;
  let encodedUrl;
  try {
    const parsedUrl = new URL(url);
    encodedUrl = parsedUrl.href;
    filename = decodeURIComponent(path.basename(parsedUrl.pathname)).replace(/['<>:"/\\|?*]/g, '_');
    if (!filename || filename === '_') {
       filename = 'video_' + Date.now() + '.mp4';
    }
  } catch (e) {
    return res.status(400).send('Invalid URL.');
  }

  const outputPath = path.join(destDir, filename);
  console.log(`[API] Starting download: ${encodedUrl} -> ${outputPath}`);

  // Send immediate response to avoid timeouts
  res.status(202).send(`Download started for '${filename}'. It will appear in the playlist shortly.`);

  const curlProcess = spawn('curl', ['-fL', '-o', outputPath, encodedUrl]);

  curlProcess.on('close', (code) => {
    if (code === 0) {
      console.log(`[API] Download complete: ${filename}`);
    } else {
      console.error(`[API] Download failed with code ${code} for URL: ${url}`);
      // Clean up partial file if any
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  });
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

app.post('/api/stream/start/:id', (req, res) => {
  const { id } = req.params;
  const dest = destinations.find(d => d.id === id);

  if (!dest) return res.status(404).send('Destination not found.');
  if (activeStreams.has(id)) return res.status(400).send('Stream is already running.');

  const destDir = path.join(PLAYLISTS_DIR, id);
  const videoFiles = fs.readdirSync(destDir).filter(f => !f.startsWith('.') && f !== 'playlist.txt');
  if (videoFiles.length === 0) return res.status(400).send('Playlist is empty.');

  const playlistFile = path.join(destDir, 'playlist.txt');
  const playlistContent = videoFiles.map(file => "file '" + path.join(destDir, file).replace(/'/g, "'\\''") + "'").join('\n');
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
