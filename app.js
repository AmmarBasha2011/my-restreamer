const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.avi', '.flv', '.wmv'];
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

const syncRepo = async (id) => {
  const dest = destinations.find(d => d.id === id);
  if (!dest || !dest.repoUrl) return;

  const destDir = path.join(PLAYLISTS_DIR, id);
  const repoDir = path.join(destDir, '.repo');

  try {
    if (!fs.existsSync(repoDir)) {
      console.log(`[Sync] Cloning repo for ${dest.name}: ${dest.repoUrl}`);
      await new Promise((resolve, reject) => {
        const git = spawn('git', ['clone', '--depth', '1', dest.repoUrl, repoDir]);
        git.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Git clone failed with code ${code}`)));
      });
    } else {
      console.log(`[Sync] Pulling updates for ${dest.name}`);
      await new Promise((resolve, reject) => {
        const git = spawn('git', ['-C', repoDir, 'pull']);
        git.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Git pull failed with code ${code}`)));
      });
    }

    const findVideos = async (dir, fileList = []) => {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
          if (file !== '.git') await findVideos(filePath, fileList);
        } else {
          if (VIDEO_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
            fileList.push(filePath);
          }
        }
      }
      return fileList;
    };

    const videosInRepo = await findVideos(repoDir);
    const videoFilenamesInRepo = videosInRepo.map(v => path.basename(v));

    for (const videoPath of videosInRepo) {
      const filename = path.basename(videoPath);
      const targetPath = path.join(destDir, filename);

      const statsRepo = await fs.promises.stat(videoPath);
      let shouldCopy = true;
      if (fs.existsSync(targetPath)) {
        const statsTarget = await fs.promises.stat(targetPath);
        // Compare size and mtime (with 1s tolerance for some filesystems)
        if (statsRepo.size === statsTarget.size && Math.abs(statsRepo.mtime.getTime() - statsTarget.mtime.getTime()) < 1000) {
          shouldCopy = false;
        }
      }

      if (shouldCopy) {
        await fs.promises.copyFile(videoPath, targetPath);
        console.log(`[Sync] Syncing video: ${filename}`);
      }
    }

    const filesInDest = await fs.promises.readdir(destDir);
    for (const file of filesInDest) {
      const filePath = path.join(destDir, file);
      const stats = await fs.promises.stat(filePath);
      if (stats.isDirectory()) continue;
      if (file === 'playlist.txt') continue;

      const isVideo = VIDEO_EXTENSIONS.includes(path.extname(file).toLowerCase());
      if (isVideo) {
        if (!videoFilenamesInRepo.includes(file)) {
          await fs.promises.unlink(filePath);
          console.log(`[Sync] Removed old video: ${file}`);
        }
      } else {
        // Delete any non-video file from playlist dir (as requested)
        await fs.promises.unlink(filePath);
        console.log(`[Sync] Removed non-video file: ${file}`);
      }
    }
  } catch (err) {
    console.error(`[Sync] Error syncing repo for ${dest.name}:`, err.message);
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
