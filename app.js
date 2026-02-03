import express from 'express';
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
const RAPIDAPI_KEYS = [
  '90e2561aefmshb1e09ecc9fe7ff0p1c02c6jsnc7805861cede',
  '77e358f168msh88950a311fa7bdep121156jsn292a1db3d2c4',
  '0a3d9e3082msh791e7df977ab33bp143086jsn80a71254f260',
  'e7f8ca51bemsh02fcafaf0277020p1e3154jsn9dcf4448d4ca',
  'af318920e4msh478e356ae0b8d0ep1f081cjsn874b37c1848e'
];
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'yt-video-audio-downloader-api.p.rapidapi.com';
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
const channelStates = new Map(); // In-memory state: K: destId, V: { nowPlaying, nowDownloading, logs, rateLimits }
const activeStreams = new Map(); // K: destinationId, V: ffmpegProcess

// Initialize destinations with missing properties
destinations = destinations.map(dest => ({
  playlistUrl: '',
  videoIds: [],
  currentIndex: 0,
  isActive: false,
  ...dest
}));

// Self-healing: Ensure playlist directories exist for all known destinations on startup
destinations.forEach(dest => {
  const destDir = path.join(PLAYLISTS_DIR, dest.id);
  if (!fs.existsSync(destDir)) {
    console.log(`[Startup] Playlist directory for '${dest.name}' not found. Creating: ${destDir}`);
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Initialize in-memory state
  channelStates.set(dest.id, {
    nowPlaying: null,
    nowDownloading: null,
    logs: [`[System] Initialized channel: ${dest.name}`],
    rateLimits: { remaining: RAPIDAPI_KEYS.length * 50, resetIn: 'N/A' }
  });
});

// --- HELPER FUNCTIONS ---
const saveDestinations = () => {
  fs.writeFileSync(DESTINATIONS_FILE, JSON.stringify(destinations, null, 2));
};

const addLog = (destId, message) => {
  const state = channelStates.get(destId);
  if (state) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    state.logs.push(logEntry);
    if (state.logs.length > 50) state.logs.shift();
    console.log(`[Channel:${destId}] ${message}`);
  }
};

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static('public'));

// Multer removed as per user request (no file uploads)

// --- API: DESTINATION & PLAYLIST MANAGEMENT ---

app.get('/api/destinations', (req, res) => {
  const fullDestinations = destinations.map(dest => {
    const state = channelStates.get(dest.id) || {};
    return {
      ...dest,
      isStreaming: activeStreams.has(dest.id),
      state: state
    };
  });
  res.json(fullDestinations);
});

app.post('/api/destinations', (req, res) => {
  const { name, key, playlistUrl } = req.body;
  if (!name || !key) return res.status(400).send('Name and Key are required.');
  
  const id = crypto.randomUUID();
  const newDestination = {
    id,
    name,
    key,
    playlistUrl: playlistUrl || '',
    videoIds: [],
    currentIndex: 0,
    isActive: false
  };
  destinations.push(newDestination);
  
  // Create a dedicated directory for this destination's playlist
  fs.mkdirSync(path.join(PLAYLISTS_DIR, id));
  
  // Initialize in-memory state
  channelStates.set(id, {
    nowPlaying: null,
    nowDownloading: null,
    logs: [`[System] Created channel: ${name}`],
    rateLimits: { remaining: RAPIDAPI_KEYS.length * 50, resetIn: 'N/A' }
  });

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

app.put('/api/destinations/:id/playlist', (req, res) => {
  const { id } = req.params;
  const { playlistUrl } = req.body;
  if (!playlistUrl) return res.status(400).send('Playlist URL is required.');

  const dest = destinations.find(d => d.id === id);
  if (!dest) return res.status(404).send('Destination not found.');
  if (dest.isActive) return res.status(400).send('Cannot update playlist while stream is active.');

  dest.playlistUrl = playlistUrl;
  dest.videoIds = []; // Reset IDs to trigger fresh extraction
  dest.currentIndex = 0; // Start from beginning

  addLog(id, `[System] Playlist URL updated to: ${playlistUrl}`);
  saveDestinations();
  res.status(200).send('Playlist URL updated.');
});

app.delete('/api/destinations/:id', (req, res) => {
  const { id } = req.params;
  const dest = destinations.find(d => d.id === id);
  if (dest && dest.isActive) return res.status(400).send('Cannot delete with an active stream.');

  destinations = destinations.filter(d => d.id !== id);
  channelStates.delete(id);

  const destDir = path.join(PLAYLISTS_DIR, id);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  saveDestinations();
  res.status(200).send('Destination and its playlist deleted.');
});

app.post('/api/playlist/clear/:id', (req, res) => {
  const { id } = req.params;
  const dest = destinations.find(d => d.id === id);
  if (dest && dest.isActive) return res.status(400).send('Cannot clear cache while stream is active.');
  
  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return res.status(404).send('Cache folder not found.');

  fs.readdirSync(destDir).forEach(file => {
    try { fs.unlinkSync(path.join(destDir, file)); } catch (e) {}
  });
  res.status(200).send('Cache cleared successfully.');
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

// --- RAPIDAPI HELPERS & KEY ROTATION MANAGER ---

class KeyManager {
  constructor(keys) {
    this.keys = keys.map(k => ({
      value: k,
      hourlyDownloads: 0,
      minuteDownloads: 0,
      lastResetHour: Date.now(),
      lastResetMinute: Date.now()
    }));
  }

  async getAvailableKey(destId) {
    const now = Date.now();
    let minWait = Infinity;

    for (const k of this.keys) {
      // Reset minute counter
      if (now - k.lastResetMinute > 60000) {
        k.minuteDownloads = 0;
        k.lastResetMinute = now;
      }

      // Reset hourly counter
      if (now - k.lastResetHour > 3600000) {
        k.hourlyDownloads = 0;
        k.lastResetHour = now;
      }

      if (k.minuteDownloads < 3 && k.hourlyDownloads < 50) {
        const state = channelStates.get(destId);
        if (state) {
          state.rateLimits.remaining = this.getTotalRemaining();
          const nextReset = 3600000 - (now - k.lastResetHour);
          state.rateLimits.resetIn = `${Math.ceil(nextReset / 60000)}m`;
        }
        return k;
      }

      // Track wait times
      const minuteWait = (k.minuteDownloads >= 3) ? (60000 - (now - k.lastResetMinute)) : 0;
      const hourlyWait = (k.hourlyDownloads >= 50) ? (3600000 - (now - k.lastResetHour)) : 0;
      const wait = Math.max(minuteWait, hourlyWait);
      if (wait > 0) minWait = Math.min(minWait, wait);
    }

    // No key available
    const waitSeconds = Math.ceil((minWait === Infinity ? 5000 : minWait) / 1000);
    addLog(destId, `[RateLimit] All keys exhausted. Waiting ${waitSeconds}s...`);
    await new Promise(r => setTimeout(r, Math.max(minWait === Infinity ? 5000 : minWait, 5000)));
    return this.getAvailableKey(destId);
  }

  getTotalRemaining() {
    return this.keys.reduce((acc, k) => acc + (50 - k.hourlyDownloads), 0);
  }

  recordDownload(keyObj) {
    keyObj.hourlyDownloads++;
    keyObj.minuteDownloads++;
  }

  markRateLimited(keyObj) {
    keyObj.hourlyDownloads = 50; // Force out of hourly rotation
    keyObj.minuteDownloads = 3;   // Force out of minute rotation
  }
}

const keyManager = new KeyManager(RAPIDAPI_KEYS);

/**
 * Fetches video metadata using youtubei.js to save RapidAPI quota.
 */
async function fetchVideoInfo(yt, videoId) {
  try {
    const info = await yt.getBasicInfo(videoId);
    return {
      title: info.basic_info.title,
      videoId: videoId
    };
  } catch (err) {
    console.error(`[YouTube] Failed to fetch info for ${videoId}:`, err.message);
    return { title: videoId, videoId: videoId };
  }
}

/**
 * Initiates a download job on RapidAPI.
 * Tries both /v1 prefix and POST/GET combinations to be robust.
 */
async function startDownloadJob(url, apiKey, format = 'mp4', quality = "360") {
  const endpoints = [
    { url: `https://${RAPIDAPI_HOST}/v1/download`, method: 'POST', body: { url, format, quality } },
    { url: `https://${RAPIDAPI_HOST}/download`, method: 'POST', body: { url, format, quality } },
    { url: `https://${RAPIDAPI_HOST}/download?url=${encodeURIComponent(url)}&format=${format}&quality=${quality}`, method: 'GET' }
  ];

  for (const ep of endpoints) {
    try {
      const options = {
        method: ep.method,
        headers: {
          'x-rapidapi-host': RAPIDAPI_HOST,
          'x-rapidapi-key': apiKey,
          'User-Agent': RAPIDAPI_USER_AGENT
        }
      };
      if (ep.method === 'POST') {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(ep.body);
      }

      const response = await fetch(ep.url, options);
      if (response.status === 429) throw new Error('TOO_MANY_REQUESTS');
      if (response.ok) return await response.json();

      console.log(`[RapidAPI] Endpoint ${ep.url} failed with ${response.status}. Trying next...`);
    } catch (err) {
      if (err.message === 'TOO_MANY_REQUESTS') throw err;
      console.log(`[RapidAPI] Error calling ${ep.url}: ${err.message}`);
    }
  }
  throw new Error('RapidAPI download initiation failed on all endpoint variations.');
}

/**
 * Polls the download job status.
 */
async function pollJobStatus(jobId, apiKey) {
  const maxRetries = 30; // 10 minutes with 20s interval
  const endpoints = [
    `https://${RAPIDAPI_HOST}/v1/status?jobId=${jobId}`,
    `https://${RAPIDAPI_HOST}/status?jobId=${jobId}`,
    `https://${RAPIDAPI_HOST}/v1/status/${jobId}`,
    `https://${RAPIDAPI_HOST}/status/${jobId}`
  ];

  for (let i = 0; i < maxRetries; i++) {
    let data = null;
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'x-rapidapi-host': RAPIDAPI_HOST,
            'x-rapidapi-key': apiKey,
            'User-Agent': RAPIDAPI_USER_AGENT
          }
        });
        if (response.status === 429) throw new Error('TOO_MANY_REQUESTS');
        if (response.ok) {
          data = await response.json();
          break;
        }
      } catch (err) {
        if (err.message === 'TOO_MANY_REQUESTS') throw err;
        lastError = err.message;
      }
    }

    if (!data) throw new Error(`RapidAPI status check failed: ${lastError || 'Unknown error'}`);

    if (data.status === 'completed') return data;
    if (data.status === 'error' || data.error) {
      throw new Error(`RapidAPI job error: ${data.message || data.error || 'Unknown error'}`);
    }

    console.log(`[RapidAPI] Job ${jobId} status: ${data.status} (${data.progress || '0%'})`);
    await new Promise(resolve => setTimeout(resolve, 20000));
  }
  throw new Error('RapidAPI job timed out.');
}

/**
 * Downloads the processed file from RapidAPI.
 */
async function downloadFinalFile(jobId, filename, outputPath, apiKey) {
  const endpoints = [
    `https://${RAPIDAPI_HOST}/v1/file?jobId=${jobId}`,
    `https://${RAPIDAPI_HOST}/file?jobId=${jobId}`,
    `https://${RAPIDAPI_HOST}/v1/file/${jobId}/${encodeURIComponent(filename)}`,
    `https://${RAPIDAPI_HOST}/file/${jobId}/${encodeURIComponent(filename)}`
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'x-rapidapi-host': RAPIDAPI_HOST,
          'x-rapidapi-key': apiKey,
          'User-Agent': RAPIDAPI_USER_AGENT
        }
      });
      if (response.status === 429) throw new Error('TOO_MANY_REQUESTS');
      if (response.ok) {
        const fileStream = fs.createWriteStream(outputPath);
        const reader = Readable.fromWeb(response.body);
        reader.pipe(fileStream);
        return new Promise((resolve, reject) => {
          fileStream.on('finish', resolve);
          fileStream.on('error', reject);
        });
      }
    } catch (err) {
      if (err.message === 'TOO_MANY_REQUESTS') throw err;
    }
  }
  throw new Error('RapidAPI file fetch failed on all endpoint variations.');
}

/**
 * Orchestrates the video download process using RapidAPI with fallback and key rotation.
 */
const downloadVideo = async (destId, yt, videoId, destDir, format = 'mp4', requestedQuality = 360) => {
  let attempts = 0;
  const maxAttempts = RAPIDAPI_KEYS.length;
  // User wants 360p by default. Fallback to 480/720 only if 360 fails with 403 (Forbidden).
  const qualitiesToTry = [360, 480, 720];

  while (attempts < maxAttempts) {
    const keyObj = await keyManager.getAvailableKey(destId);
    try {
      for (const quality of qualitiesToTry) {
        try {
          const state = channelStates.get(destId);
          if (state && state.nowDownloading) state.nowDownloading.quality = `${quality}p`;
          addLog(destId, `[RapidAPI] Attempting download: ${videoId} (${quality}p)`);
          await downloadVideoInternal(destId, yt, videoId, destDir, format, quality, keyObj);
          return; // Success!
        } catch (err) {
          // If 403 Forbidden or "empty file" or "Bad Request", try next quality
          if (err.message.includes('403') || err.message.includes('Forbidden') || err.message.includes('empty') || err.message.includes('400')) {
            addLog(destId, `[RapidAPI] ${quality}p failed (${err.message}). Trying next quality...`);
            continue;
          }
          // If rate limited, switch key
          if (err.message === 'TOO_MANY_REQUESTS' || err.message.includes('429')) {
            throw err;
          }
          // For other errors, log and potentially try next quality or switch key
          addLog(destId, `[RapidAPI] Error with ${quality}p: ${err.message}`);
          if (quality === qualitiesToTry[qualitiesToTry.length - 1]) throw err; // Last quality failed
        }
      }
    } catch (err) {
      if (err.message === 'TOO_MANY_REQUESTS') {
        addLog(destId, `[RateLimit] Key ${keyObj.value.substring(0, 8)}... reported 429. Switching key.`);
        keyManager.markRateLimited(keyObj);
        attempts++;
        continue;
      }
      // For general failures, also try switching key to be safe
      addLog(destId, `[Error] Key ${keyObj.value.substring(0, 8)}... failed. Switching key.`);
      attempts++;
      continue;
    }
  }
  throw new Error('All API keys exhausted or failed to download video.');
};

/**
 * Internal orchestrator for RapidAPI download.
 */
const downloadVideoInternal = async (destId, yt, videoId, destDir, format, quality, keyObj) => {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const apiKey = keyObj.value;
  try {
    const info = await fetchVideoInfo(yt, videoId);
    const title = (info.title || videoId).replace(/[\\/:*?"<>|]/g, '_');
    const filename = `${title}.${format}`;
    const outputPath = path.join(destDir, filename);

    // Add small burst protection delay
    await new Promise(r => setTimeout(r, 2000));

    const job = await startDownloadJob(url, apiKey, format, String(quality));

    if (job.directDownload && job.downloadUrl) {
      console.log(`[RapidAPI] Direct download available: ${job.downloadUrl}`);
      // Try fetching direct link
      const response = await fetch(job.downloadUrl, {
        headers: { 'User-Agent': RAPIDAPI_USER_AGENT }
      });

      if (!response.ok) {
        throw new Error(`Direct download failed: ${response.status} ${response.statusText}`);
      }

      const fileStream = fs.createWriteStream(outputPath);
      const reader = Readable.fromWeb(response.body);
      reader.pipe(fileStream);
      await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
    } else if (job.jobId) {
      addLog(destId, `[RapidAPI] Job initiated: ${job.jobId}. Polling...`);
      const completedJob = await pollJobStatus(job.jobId, apiKey);

      let downloadUrl = completedJob.downloadUrl;
      // Ensure downloadUrl is absolute for the file fetch
      if (downloadUrl && !downloadUrl.startsWith('http')) {
          downloadUrl = `https://${RAPIDAPI_HOST}${downloadUrl}`;
      }

      const headers = { 'User-Agent': RAPIDAPI_USER_AGENT };
      if (downloadUrl.includes(RAPIDAPI_HOST) || downloadUrl.includes('youtubedownloadapi.com')) {
        headers['x-rapidapi-key'] = apiKey;
        headers['x-rapidapi-host'] = RAPIDAPI_HOST;
      }

      const response = await fetch(downloadUrl, { headers });
      if (!response.ok) throw new Error(`File fetch failed: ${response.statusText}`);

      const fileStream = fs.createWriteStream(outputPath);
      const reader = Readable.fromWeb(response.body);
      reader.pipe(fileStream);
      await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
    } else {
        throw new Error('No jobId or downloadUrl returned from API.');
    }

    addLog(destId, `[RapidAPI] Success: ${filename}`);
    keyManager.recordDownload(keyObj);

  } catch (err) {
    console.error(`[RapidAPI] Internal Error:`, err.message);
    throw err;
  }
};

// Individual YouTube add endpoint removed in favor of Playlist Loop

const runChannelLoop = async (destId) => {
  const dest = destinations.find(d => d.id === destId);
  if (!dest || !dest.isActive) return;

  const state = channelStates.get(destId);
  const destDir = path.join(PLAYLISTS_DIR, destId);

  try {
    // Shared YouTube client for metadata (not for downloading)
    const yt = await Innertube.create({ cache: new UniversalCache(false), generate_session_store: true, client: 'ANDROID' });

    // 1. Extract Playlist if needed
    if (!dest.videoIds || dest.videoIds.length === 0) {
      addLog(destId, `[System] Extracting playlist IDs...`);
      const playlistId = extractPlaylistId(dest.playlistUrl);
      if (!playlistId) throw new Error('Invalid playlist URL');
      const playlist = await yt.getPlaylist(playlistId);
      dest.videoIds = playlist.videos.map(v => v.id).filter(id => !!id);
      addLog(destId, `[System] Found ${dest.videoIds.length} videos.`);
      saveDestinations();
    }

    while (dest.isActive) {
      const vId = dest.videoIds[dest.currentIndex];
      const nextIdx = (dest.currentIndex + 1) % dest.videoIds.length;
      const nextVId = dest.videoIds[nextIdx];

      // 2. Download Current Video (if not already there)
      const files = fs.readdirSync(destDir).filter(f => f.includes(vId));
      let currentFile = files.length > 0 ? path.join(destDir, files[0]) : null;

      if (!currentFile) {
        addLog(destId, `[System] Downloading video ${dest.currentIndex + 1}/${dest.videoIds.length}: ${vId}`);
        state.nowDownloading = { id: vId, progress: '0%' };
        await downloadVideo(destId, yt, vId, destDir);
        state.nowDownloading = null;
        currentFile = path.join(destDir, fs.readdirSync(destDir).find(f => f.includes(vId)));
      }

      // 3. Start Streaming
      addLog(destId, `[Stream] Starting: ${path.basename(currentFile)}`);
      state.nowPlaying = { title: path.basename(currentFile), id: vId };

      // Re-encode to ensure stream stability across different video files
      const ffmpegArgs = [
        '-re', '-i', currentFile,
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k',
        '-vf', 'scale=640:360,format=yuv420p', '-g', '60',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-f', 'flv', `rtmp://a.rtmp.youtube.com/live2/${dest.key}`
      ];

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      activeStreams.set(destId, ffmpegProcess);

      // 4. While streaming, download next video (buffer)
      const downloadNext = async () => {
        const nextFiles = fs.readdirSync(destDir).filter(f => f.includes(nextVId));
        if (nextFiles.length === 0) {
          addLog(destId, `[System] Buffering next video: ${nextVId}`);
          state.nowDownloading = { id: nextVId, progress: 'Buffered' };
          try {
            await downloadVideo(destId, yt, nextVId, destDir);
            addLog(destId, `[System] Next video buffered.`);
          } catch (e) {
            addLog(destId, `[Error] Failed to buffer next video: ${e.message}`);
          }
          state.nowDownloading = null;
        }
      };

      downloadNext(); // Run in background

      // 5. Wait for current video to finish
      await new Promise((resolve) => {
        ffmpegProcess.on('close', (code) => {
          addLog(destId, `[Stream] Finished (code ${code})`);
          activeStreams.delete(destId);
          resolve();
        });
        ffmpegProcess.stderr.on('data', (data) => {
          // Can parse ffmpeg progress here if needed
        });
      });

      // 6. Delete old file to save space
      if (currentFile && fs.existsSync(currentFile)) {
        addLog(destId, `[System] Deleting finished video: ${path.basename(currentFile)}`);
        fs.unlinkSync(currentFile);
      }

      // 7. Advance to next
      dest.currentIndex = nextIdx;
      saveDestinations();

      if (!dest.isActive) break;
      addLog(destId, `[Loop] Moving to next video...`);
    }
  } catch (err) {
    addLog(destId, `[Critical Error] Loop stopped: ${err.message}`);
    dest.isActive = false;
    saveDestinations();
  }
};

app.post('/api/stream/start/:id', async (req, res) => {
  const { id } = req.params;
  const dest = destinations.find(d => d.id === id);

  if (!dest) return res.status(404).send('Destination not found.');
  if (dest.isActive) return res.status(400).send('Stream is already active.');

  dest.isActive = true;
  saveDestinations();
  runChannelLoop(id); // Start the loop in background

  res.status(200).send(`Stream loop started for '${dest.name}'.`);
});

app.post('/api/stream/stop/:id', (req, res) => {
  const { id } = req.params;
  console.log(`[API] Action: Stop Stream | Destination ID: ${id}`);

  const dest = destinations.find(d => d.id === id);
  if (dest) {
    dest.isActive = false;
    saveDestinations();
  }

  const process = activeStreams.get(id);
  if (process) {
    process.kill('SIGKILL');
    activeStreams.delete(id);
  }

  res.status(200).send(`Stream stopping for '${dest?.name || id}'.`);
});

// --- SERVER START ---
app.listen(PORT, () => {
  console.log(`Per-stream playlist Restreamer running on http://localhost:${PORT}`);

  // Resume active streams
  destinations.forEach(dest => {
    if (dest.isActive) {
      addLog(dest.id, `[System] Resuming active stream...`);
      runChannelLoop(dest.id);
    }
  });
});
