const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.webm'];
const PORT = process.env.PORT || 3000;

// --- LOGGING SYSTEM (SSE) ---
let clients = [];
const logToClients = (message, type = 'info') => {
  console.log(`[${type.toUpperCase()}] ${message}`);
  const data = JSON.stringify({ message, type, timestamp: new Date().toISOString() });
  clients.forEach(client => client.res.write(`data: ${data}\n\n`));
};

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

const downloadFile = async (url, outputPath) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  await fs.promises.writeFile(outputPath, Buffer.from(buffer));
};

const syncRepo = async (id) => {
  const dest = destinations.find(d => d.id === id);
  if (!dest || !dest.repoUrl) return;

  logToClients(`Syncing repository for ${dest.name}...`, 'sync');
  const destDir = path.join(PLAYLISTS_DIR, id);

  try {
    // Parse GitHub URL
    let repoMatch = dest.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (!repoMatch) {
      logToClients(`Invalid GitHub URL: ${dest.repoUrl}`, 'error');
      return;
    }
    const [_, owner, repo] = repoMatch;

    // Fetch repo tree via GitHub API
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`GitHub API error: ${res.statusText}`);
    const data = await res.json();

    const videoFiles = data.tree.filter(f => f.type === 'blob' && VIDEO_EXTENSIONS.includes(path.extname(f.path).toLowerCase()));
    const videoFilenamesInRepo = videoFiles.map(f => path.basename(f.path));

    // Download new/updated videos
    for (const file of videoFiles) {
      const filename = path.basename(file.path);
      const targetPath = path.join(destDir, filename);
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${file.path}`;

      let shouldDownload = true;
      if (fs.existsSync(targetPath)) {
        const stats = await fs.promises.stat(targetPath);
        if (stats.size === file.size) {
          shouldDownload = false;
        }
      }

      if (shouldDownload) {
        logToClients(`Downloading: ${filename}`, 'sync');
        await downloadFile(rawUrl, targetPath);
      }
    }

    // Cleanup: remove old videos or non-video files
    const filesInDest = await fs.promises.readdir(destDir);
    for (const file of filesInDest) {
      const filePath = path.join(destDir, file);
      const stats = await fs.promises.stat(filePath);
      if (stats.isDirectory()) continue;
      if (file === 'playlist.txt') continue;

      if (VIDEO_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
        if (!videoFilenamesInRepo.includes(file)) {
          await fs.promises.unlink(filePath);
          logToClients(`Removed old video: ${file}`, 'info');
        }
      } else {
        await fs.promises.unlink(filePath);
        logToClients(`Removed non-video file: ${file}`, 'info');
      }
    }
    logToClients(`Sync complete for ${dest.name}`, 'success');
  } catch (err) {
    logToClients(`Sync failed for ${dest.name}: ${err.message}`, 'error');
  }
};

setInterval(() => {
  console.log('[Sync] Starting periodic sync for all repos...');
  destinations.forEach(dest => {
    if (dest.repoUrl) syncRepo(dest.id);
  });
}, 20 * 60 * 1000);

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static('public'));

// --- API: REAL-TIME LOGS (SSE) ---
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

// --- API: DESTINATION & PLAYLIST MANAGEMENT ---

app.get('/api/destinations', (req, res) => {
  const fullDestinations = destinations.map(dest => {
    const destDir = path.join(PLAYLISTS_DIR, dest.id);
    const videos = fs.existsSync(destDir) ? fs.readdirSync(destDir).filter(f => !f.startsWith('.') && f !== 'playlist.txt' && !fs.statSync(path.join(destDir, f)).isDirectory()) : [];
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

app.post('/api/destinations/:id/repo', async (req, res) => {
  const { id } = req.params;
  const { repoUrl } = req.body;

  if (!repoUrl) return res.status(400).send('Repository URL is required.');

  const dest = destinations.find(d => d.id === id);
  if (!dest) return res.status(404).send('Destination not found.');

  dest.repoUrl = repoUrl;
  saveDestinations();

  logToClients(`Repository updated for ${dest.name}: ${repoUrl}`, 'info');
  res.status(202).send('Repository URL updated. Sync started in background.');

  // Trigger immediate sync
  syncRepo(id);
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

  logToClients(`Stream started for ${dest.name}`, 'success');

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('failed')) {
      logToClients(`[${dest.name}] FFmpeg: ${msg}`, 'error');
    }
  });

  ffmpegProcess.on('close', (code) => {
    logToClients(`Stream stopped for ${dest.name} (code ${code})`, code === 0 ? 'info' : 'error');
    activeStreams.delete(id);
    if (fs.existsSync(playlistFile)) fs.unlinkSync(playlistFile); // Clean up playlist file
  });

  res.status(200).send(`Stream started for '${dest.name}'.`);
});

app.post('/api/stream/stop/:id', (req, res) => {
  const { id } = req.params;
  const dest = destinations.find(d => d.id === id);
  const process = activeStreams.get(id);

  if (process) {
    logToClients(`Stopping stream for ${dest ? dest.name : id}`, 'info');
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

  // Initial sync on startup
  destinations.forEach(dest => {
    if (dest.repoUrl) syncRepo(dest.id);
  });
});
