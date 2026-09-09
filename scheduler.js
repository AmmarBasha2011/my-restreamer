const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { refreshAccessTokenIfNeeded, createAndGoLive, transitionToComplete } = require('./youtube-api');

const DESTINATIONS_FILE = path.join(__dirname, 'destinations.json');
const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json');
const PLAYLISTS_DIR = path.join(__dirname, 'playlists');

// Store active cron jobs and YouTube streams
const scheduledJobs = new Map(); // destId -> cron task
const activeYouTubeStreams = new Map(); // destId -> { broadcastId, streamId, ffmpegProcess, currentTrackIndex }

// Load saved YouTube credentials
function loadCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  }
  return null;
}

function saveCredentials(credentials) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
}

// --- YOUTUBE NON-24 STREAMING ---

async function startNon24Stream(dest) {
  const credentials = loadCredentials();
  if (!credentials) {
    console.error(`[${dest.name}] No YouTube credentials found. Please authenticate first.`);
    return { success: false, error: 'No YouTube credentials. Please authenticate in Settings.' };
  }

  // Refresh token if needed
  const validCreds = await refreshAccessTokenIfNeeded(credentials);
  if (!validCreds) {
    console.error(`[${dest.name}] YouTube credentials expired. Please re-authenticate.`);
    return { success: false, error: 'YouTube credentials expired. Please re-authenticate.' };
  }
  if (validCreds !== credentials) {
    saveCredentials(validCreds);
  }

  const destDir = path.join(PLAYLISTS_DIR, dest.id);
  if (!fs.existsSync(destDir)) {
    return { success: false, error: 'Playlist folder missing.' };
  }

  const videoExts = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.m4v'];
  const videoFiles = fs.readdirSync(destDir).filter(f => !f.startsWith('.') && videoExts.includes(path.extname(f).toLowerCase()));
  if (videoFiles.length === 0) {
    return { success: false, error: 'Playlist is empty.' };
  }

  try {
    // Create YouTube Live broadcast + stream
    const streamInfo = await createAndGoLive(
      dest.schedule.title || dest.name,
      dest.schedule.description || `Live stream for ${dest.name}`,
      dest.schedule.categoryId || '27'
    );

    console.log(`[${dest.name}] YouTube broadcast created: ${streamInfo.broadcastUrl}`);
    console.log(`[${dest.name}] RTMP URL: ${streamInfo.ingestionAddress}/${streamInfo.streamName}`);

    // Start FFmpeg streaming to YouTube
    const currentVideoPath = path.join(destDir, videoFiles[0]);
    
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
      `${streamInfo.ingestionAddress}/${streamInfo.streamName}`
    ];

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('channel element')) {
        console.error(`[${dest.name}] ffmpeg error: ${msg.trim()}`);
      }
    });

    ffmpegProcess.on('close', async (code) => {
      console.log(`[${dest.name}] Stream ended with code ${code}`);
      // End the YouTube broadcast
      try {
        await transitionToComplete(streamInfo.broadcastId);
        console.log(`[${dest.name}] YouTube broadcast marked as complete.`);
      } catch (err) {
        console.error(`[${dest.name}] Error ending broadcast:`, err.message);
      }
      activeYouTubeStreams.delete(dest.id);
    });

    activeYouTubeStreams.set(dest.id, {
      broadcastId: streamInfo.broadcastId,
      streamId: streamInfo.streamId,
      ingestionAddress: streamInfo.ingestionAddress,
      streamName: streamInfo.streamName,
      broadcastUrl: streamInfo.broadcastUrl,
      ffmpegProcess,
      currentTrackIndex: 0
    });

    return { 
      success: true, 
      broadcastUrl: streamInfo.broadcastUrl,
      message: `Non-24 stream started! Watch: ${streamInfo.broadcastUrl}`
    };

  } catch (err) {
    console.error(`[${dest.name}] Error starting Non-24 stream:`, err.message);
    return { success: false, error: err.message };
  }
}

function stopNon24Stream(destId) {
  const streamData = activeYouTubeStreams.get(destId);
  if (!streamData) return false;
  
  streamData.ffmpegProcess.kill('SIGKILL');
  activeYouTubeStreams.delete(destId);
  return true;
}

// --- SCHEDULER ---

function initializeScheduledJobs() {
  const destinations = JSON.parse(fs.readFileSync(DESTINATIONS_FILE, 'utf-8'));
  
  destinations.forEach(dest => {
    if (dest.type === 'non24' && dest.schedule && dest.schedule.mode === 'scheduled' && dest.schedule.cron) {
      scheduleStream(dest);
    }
  });
}

function scheduleStream(dest) {
  if (!dest.schedule || !dest.schedule.cron) return;
  
  // Stop existing job if any
  unscheduleStream(dest.id);

  if (!cron.validate(dest.schedule.cron)) {
    console.error(`[Scheduler] Invalid cron expression for '${dest.name}': ${dest.schedule.cron}`);
    return;
  }

  console.log(`[Scheduler] Scheduling '${dest.name}' with cron: ${dest.schedule.cron}`);
  
  const job = cron.schedule(dest.schedule.cron, async () => {
    console.log(`[Scheduler] Triggered for '${dest.name}' at ${new Date().toISOString()}`);
    
    // Check if already streaming
    if (activeYouTubeStreams.has(dest.id)) {
      console.log(`[Scheduler] '${dest.name}' is already streaming. Skipping.`);
      return;
    }

    const result = await startNon24Stream(dest);
    if (!result.success) {
      console.error(`[Scheduler] Failed to start stream for '${dest.name}': ${result.error}`);
    }
  });

  scheduledJobs.set(dest.id, job);
}

function unscheduleStream(destId) {
  const job = scheduledJobs.get(destId);
  if (job) {
    job.stop();
    scheduledJobs.delete(destId);
  }
}

function isStreaming(destId) {
  return activeYouTubeStreams.has(destId);
}

module.exports = {
  startNon24Stream,
  stopNon24Stream,
  scheduleStream,
  unscheduleStream,
  isStreaming,
  initializeScheduledJobs,
  loadCredentials,
  saveCredentials
};
