const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const { getAuthUrl, setTokensFromCode } = require('./youtube-api');
const { startNon24Stream, stopNon24Stream, scheduleStream, unscheduleStream, isStreaming, initializeScheduledJobs, loadCredentials, saveCredentials } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 7860;

// --- AUTH CONFIGURATION ---
const AUTH_USERNAME = process.env.USERNAME || 'admin';
const AUTH_PASSWORD = process.env.PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// --- SESSION MIDDLEWARE ---
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true in production with HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// --- AUTH MIDDLEWARE ---
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  // For API routes, return 401
  if (req.path.startsWith('/api/') || req.path === '/auth' || req.path === '/auth/callback') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // For page routes, redirect to login
  res.redirect('/login');
};

// --- FILE PATHS ---
const PLAYLISTS_DIR = path.join(__dirname, 'playlists');
const DESTINATIONS_FILE = path.join(__dirname, 'destinations.json');

// --- SETUP AND STATE MANAGEMENT ---
if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR);
if (!fs.existsSync(DESTINATIONS_FILE)) fs.writeFileSync(DESTINATIONS_FILE, '[]');

let destinations = JSON.parse(fs.readFileSync(DESTINATIONS_FILE, 'utf-8'));

// Store active 24/7 streams
const activeStreams = new Map(); // K: destinationId, V: { process, currentTrackIndex, isManuallyStopped }

// Self-healing: Ensure playlist directories exist
destinations.forEach(dest => {
  const destDir = path.join(PLAYLISTS_DIR, dest.id);
  if (!fs.existsSync(destDir)) {
    console.log(`[Startup] Playlist directory for '${dest.name}' not found. Creating: ${destDir}`);
    fs.mkdirSync(destDir, { recursive: true });
  }
});

// Initialize scheduled jobs for Non-24 channels
initializeScheduledJobs();

// --- HELPER FUNCTIONS ---
const saveDestinations = () => {
  fs.writeFileSync(DESTINATIONS_FILE, JSON.stringify(destinations, null, 2));
};

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static('public'));

// --- LOGIN PAGE ---
app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/');
  }
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Login - Advanced Restreamer</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: linear-gradient(135deg, #6f42c1, #0d6efd);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .login-box {
          background: white;
          padding: 3rem;
          border-radius: 16px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          width: 100%;
          max-width: 400px;
        }
        h1 { color: #6f42c1; margin-bottom: 0.5rem; font-size: 1.5rem; }
        p { color: #6c757d; margin-bottom: 2rem; font-size: 0.9rem; }
        label { display: block; font-weight: 600; margin-bottom: 0.3rem; color: #495057; font-size: 0.85rem; }
        input {
          width: 100%;
          padding: 0.8rem;
          border: 2px solid #e9ecef;
          border-radius: 8px;
          margin-bottom: 1.2rem;
          font-size: 1rem;
          transition: border-color 0.2s;
        }
        input:focus { outline: none; border-color: #6f42c1; }
        button {
          width: 100%;
          padding: 0.9rem;
          background: linear-gradient(135deg, #6f42c1, #0d6efd);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(111,66,193,0.4); }
        .error { background: #fee; color: #c33; padding: 0.8rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.85rem; display: none; }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h1>🚀 Advanced Restreamer</h1>
        <p>Please sign in to continue</p>
        <div class="error" id="error"></div>
        <form id="loginForm">
          <label>Username</label>
          <input type="text" id="username" required autofocus>
          <label>Password</label>
          <input type="password" id="password" required>
          <button type="submit">Sign In</button>
        </form>
      </div>
      <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const username = document.getElementById('username').value;
          const password = document.getElementById('password').value;
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          if (res.ok) {
            window.location.href = '/';
          } else {
            const err = document.getElementById('error');
            err.textContent = 'Invalid username or password';
            err.style.display = 'block';
          }
        });
      </script>
    </body>
    </html>
  `);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USERNAME && password === AUTH_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// --- PROTECTED ROUTES ---
app.use(requireAuth);

// --- MULTER STORAGE ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const destDir = path.join(PLAYLISTS_DIR, req.params.id);
    if (!fs.existsSync(destDir)) {
      return cb(new Error('Destination playlist does not exist.'), false);
    }
    cb(null, destDir);
  },
  filename: (req, file, cb) => {
    cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
  }
});
const upload = multer({ storage: storage });

// --- YOUTUBE AUTH ROUTES ---

app.get('/auth', (req, res) => {
  const authUrl = getAuthUrl();
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authorization code missing.');
  }
  try {
    const tokens = await setTokensFromCode(code);
    saveCredentials(tokens);
    res.send(`
      <html>
        <head><title>Authentication Successful</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: #28a745;">✓ Authentication Successful!</h1>
          <p>Your YouTube account has been connected.</p>
          <p>You can close this window and return to the Restreamer.</p>
          <button onclick="window.close()" style="padding: 10px 20px; font-size: 16px; cursor: pointer;">Close Window</button>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Auth] Error:', err.message);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

app.get('/api/auth/status', (req, res) => {
  const creds = loadCredentials();
  res.json({ authenticated: !!creds });
});

// --- API: DESTINATION & PLAYLIST MANAGEMENT ---

app.get('/api/destinations', (req, res) => {
  const videoExts = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.m4v'];
  const fullDestinations = destinations.map(dest => {
    const destDir = path.join(PLAYLISTS_DIR, dest.id);
    const videos = fs.existsSync(destDir) ? fs.readdirSync(destDir).filter(f => !f.startsWith('.') && videoExts.includes(path.extname(f).toLowerCase())) : [];
    const streaming247 = activeStreams.has(dest.id);
    const streamingNon24 = isStreaming(dest.id);
    return { 
      ...dest, 
      playlist: videos, 
      isStreaming: streaming247 || streamingNon24,
      streaming247,
      streamingNon24
    };
  });
  res.json(fullDestinations);
});

app.post('/api/destinations', (req, res) => {
  const { name, key, type = '247' } = req.body;
  if (!name) return res.status(400).send('Name is required.');
  
  // For 24/7, key is required. For Non-24, key is not needed (uses YouTube API)
  if (type === '247' && !key) return res.status(400).send('Stream Key is required for 24/7 channels.');
  
  const newDestination = { 
    id: crypto.randomUUID(), 
    name, 
    key: key || null,
    type // '247' or 'non24'
  };
  
  // For Non-24, add schedule info
  if (type === 'non24') {
    const { mode, cron, title, description, categoryId } = req.body;
    newDestination.schedule = {
      mode: mode || 'manual', // 'manual' or 'scheduled'
      cron: cron || null,
      title: title || name,
      description: description || '',
      categoryId: categoryId || '27' // 27 = Education
    };
  }
  
  destinations.push(newDestination);
  fs.mkdirSync(path.join(PLAYLISTS_DIR, newDestination.id));
  saveDestinations();
  
  // If scheduled, start the cron job
  if (type === 'non24' && newDestination.schedule.mode === 'scheduled' && newDestination.schedule.cron) {
    scheduleStream(newDestination);
  }
  
  res.status(201).json(newDestination);
});

app.delete('/api/destinations/:id', (req, res) => {
  const { id } = req.params;
  if (activeStreams.has(id) || isStreaming(id)) {
    return res.status(400).send('Cannot delete with an active stream.');
  }
  
  destinations = destinations.filter(d => d.id !== id);
  const destDir = path.join(PLAYLISTS_DIR, id);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  
  // Remove scheduled job
  unscheduleStream(id);
  
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
  if (activeStreams.has(id) || isStreaming(id)) {
    return res.status(400).send('Cannot clear playlist while stream is active.');
  }
  
  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return res.status(404).send('Playlist not found.');

  fs.readdirSync(destDir).forEach(file => fs.unlinkSync(path.join(destDir, file)));
  res.status(200).send('Playlist cleared successfully.');
});

// --- API: 24/7 STREAM CONTROL ---

app.post('/api/youtube/add/:id', (req, res) => {
  const { id } = req.params;
  const { url } = req.body;
  console.log(`[API] Action: Add from YouTube | Destination ID: ${id} | URL: ${url}`);

  if (!url) return res.status(400).send('YouTube URL is required.');

  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return res.status(404).send('Destination not found.');

  const ytdlpArgs = [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', 
    '-o', path.join(destDir, '%(title)s.%(ext)s'), 
    '--extractor-args', 'youtube:player-client=android',
    '--user-agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    '--no-check-certificates',
    '--geo-bypass',
    '--sleep-requests', '1.5',
    '--no-warnings',
    url 
  ];

  console.log(`[yt-dlp] Starting clean download with args: ${ytdlpArgs.join(' ')}`);
  const ytdlpProcess = spawn('yt-dlp', ytdlpArgs);

  ytdlpProcess.stdout.on('data', (data) => console.log(`[yt-dlp] stdout: ${data}`));
  ytdlpProcess.stderr.on('data', (data) => console.error(`[yt-dlp] stderr: ${data}`));

  ytdlpProcess.on('close', (code) => {
    if (code === 0) {
      console.log(`[yt-dlp] Download finished successfully for URL: ${url}`);
    } else {
      console.error(`[yt-dlp] Process exited with code ${code} for URL: ${url}`);
    }
  });

  res.status(202).send('Download started. The video will be added to the playlist shortly.');
});

// دالة التشغيل الذكية للـ 24/7
function runDynamicStream(id, trackIndex = 0) {
  const dest = destinations.find(d => d.id === id);
  if (!dest) return;

  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return;

  const videoExts = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.m4v'];
  const videoFiles = fs.readdirSync(destDir).filter(f => !f.startsWith('.') && videoExts.includes(path.extname(f).toLowerCase()));
  if (videoFiles.length === 0) {
    console.log(`[${dest.name}] القائمة فارغة حالياً. سيتم إيقاف البث.`);
    activeStreams.delete(id);
    return;
  }

  if (trackIndex >= videoFiles.length || trackIndex < 0) {
    trackIndex = 0;
  }

  const currentVideoPath = path.join(destDir, videoFiles[trackIndex]);
  console.log(`[${dest.name}] جاري بث الملف رقم [${trackIndex}]: ${videoFiles[trackIndex]}`);

  const ffmpegArgs = [
    '-re',
    '-fflags', '+genpts+discardcorrupt+igndts',
    '-i', currentVideoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', '1500k',
    '-maxrate', '2000k',
    '-bufsize', '3000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60', 
    '-af', 'aformat=channel_layouts=stereo,aresample=async=1:min_hard_comp=0.010000:max_soft_comp=0.010000',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'flv',
    `rtmps://a.rtmp.youtube.com:443/live2/${dest.key}`
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  activeStreams.set(id, {
    process: ffmpegProcess,
    currentTrackIndex: trackIndex,
    isManuallyStopped: false
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('channel element')) {
      console.error(`[${dest.name}] ffmpeg error output: ${msg.trim()}`);
    }
  });

  ffmpegProcess.on('close', (code) => {
    const streamData = activeStreams.get(id);
    
    if (streamData && streamData.isManuallyStopped) {
      console.log(`[${dest.name}] تم إنهاء البث يدوياً من قبل المستخدم.`);
      return;
    }

    console.log(`[${dest.name}] انتهى تشغيل الفيديو بكود (${code}).`);

    let nextIndex = trackIndex + 1;

    if (code !== 0) {
      console.error(`[${dest.name}] تم رصد مشكلة تسببت في توقف الفيديو الحالي! جاري الانتقال التلقائي للفيديو التالي لمنع توقف منصة يوتيوب...`);
    }

    setTimeout(() => {
      runDynamicStream(id, nextIndex);
    }, 500);
  });
}

app.post('/api/stream/start/:id', (req, res) => {
  const { id } = req.params;
  const dest = destinations.find(d => d.id === id);

  if (!dest) return res.status(404).send('Destination not found.');
  if (activeStreams.has(id) || isStreaming(id)) {
    return res.status(400).send('Stream is already running.');
  }

  const destDir = path.join(PLAYLISTS_DIR, id);
  if (!fs.existsSync(destDir)) return res.status(404).send('Playlist folder missing.');
  
  const videoFiles = fs.readdirSync(destDir).filter(f => !f.startsWith('.'));
  if (videoFiles.length === 0) return res.status(400).send('Playlist is empty.');

  // For 24/7, use the looping stream
  if (dest.type === '247') {
    runDynamicStream(id, 0);
    res.status(200).send(`24/7 Stream started for '${dest.name}'.`);
  } else {
    // For Non-24, use YouTube API
    startNon24Stream(dest).then(result => {
      if (result.success) {
        res.status(200).send(result.message);
      } else {
        res.status(400).send(result.error);
      }
    });
  }
});

app.post('/api/stream/stop/:id', (req, res) => {
  const { id } = req.params;
  console.log(`[API] Action: Stop Stream | Destination ID: ${id}`);
  
  // Try 24/7 stop
  const streamData = activeStreams.get(id);
  if (streamData) {
    streamData.isManuallyStopped = true;
    streamData.process.kill('SIGKILL');
    activeStreams.delete(id);
    return res.status(200).send('24/7 Stream stopped.');
  }
  
  // Try Non-24 stop
  if (stopNon24Stream(id)) {
    return res.status(200).send('Non-24 Stream stopped.');
  }
  
  res.status(400).send('Stream not running.');
});

// --- API: NON-24 SCHEDULE MANAGEMENT ---

app.put('/api/destinations/:id/schedule', (req, res) => {
  const { id } = req.params;
  const dest = destinations.find(d => d.id === id);
  if (!dest) return res.status(404).send('Destination not found.');
  if (dest.type !== 'non24') return res.status(400).send('Only Non-24 channels support scheduling.');
  
  const { mode, cron, title, description, categoryId } = req.body;
  
  dest.schedule = {
    mode: mode || 'manual',
    cron: cron || null,
    title: title || dest.name,
    description: description || '',
    categoryId: categoryId || '27'
  };
  
  // Update cron job
  unscheduleStream(id);
  if (mode === 'scheduled' && cron) {
    scheduleStream(dest);
  }
  
  saveDestinations();
  res.json(dest);
});

// --- SERVER START ---
app.listen(PORT, () => {
  console.log(`Advanced Restreamer running on http://localhost:${PORT}`);
  console.log(`YouTube Auth URL: http://localhost:${PORT}/auth`);
});
