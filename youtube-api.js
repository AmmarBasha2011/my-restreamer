const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.upload'
];

function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: YOUTUBE_SCOPES,
    prompt: 'consent' // Force to get refresh token every time
  });
}

async function setTokensFromCode(code) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  return tokens;
}

function setStoredCredentials(credentials) {
  oauth2Client.setCredentials(credentials);
}

async function refreshAccessTokenIfNeeded(credentials) {
  if (!credentials.refresh_token) return credentials;
  
  oauth2Client.setCredentials(credentials);
  
  const now = Date.now();
  if (credentials.expiry_date && credentials.expiry_date > now + 60000) {
    return credentials; // Still valid
  }
  
  try {
    const { credentials: newCredentials } = await oauth2Client.refreshAccessToken();
    return newCredentials;
  } catch (err) {
    console.error('[YouTube Auth] Failed to refresh token:', err.message);
    return null;
  }
}

async function createLiveBroadcast(title, description, categoryId = '27', scheduledStartTime = null) {
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  
  const broadcastResource = {
    snippet: {
      title: title,
      description: description,
      scheduledStartTime: scheduledStartTime || new Date().toISOString()
    },
    status: {
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false
    },
    contentDetails: {
      enableAutoStart: true,
      enableAutoStop: true
    }
  };

  const response = await youtube.liveBroadcasts.insert({
    part: ['snippet', 'status', 'contentDetails'],
    resource: broadcastResource
  });

  return response.data;
}

async function createLiveStream(title) {
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  
  const streamResource = {
    snippet: {
      title: title
    },
    cdn: {
      frameRate: '30fps',
      ingestionType: 'rtmp',
      resolution: '1080p'
    }
  };

  const response = await youtube.liveStreams.insert({
    part: ['snippet', 'cdn'],
    resource: streamResource
  });

  return response.data;
}

async function bindBroadcastToStream(broadcastId, streamId) {
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  
  const response = await youtube.liveBroadcasts.bind({
    part: ['id', 'snippet', 'contentDetails', 'status'],
    id: broadcastId,
    streamId: streamId
  });

  return response.data;
}

async function transitionToLive(broadcastId) {
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  
  const response = await youtube.liveBroadcasts.transition({
    part: ['id', 'snippet', 'contentDetails', 'status'],
    id: broadcastId,
    broadcastStatus: 'live'
  });

  return response.data;
}

async function transitionToComplete(broadcastId) {
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  
  const response = await youtube.liveBroadcasts.transition({
    part: ['id', 'snippet', 'contentDetails', 'status'],
    id: broadcastId,
    broadcastStatus: 'complete'
  });

  return response.data;
}

// Full flow: create broadcast + stream + bind + go live
async function createAndGoLive(title, description, categoryId = '27') {
  const broadcast = await createLiveBroadcast(title, description, categoryId);
  const stream = await createLiveStream(title);
  await bindBroadcastToStream(broadcast.id, stream.id);
  
  return {
    broadcastId: broadcast.id,
    streamId: stream.id,
    ingestionAddress: stream.cdn.ingestionInfo.ingestionAddress,
    streamName: stream.cdn.ingestionInfo.streamName,
    broadcastUrl: `https://youtube.com/watch?v=${broadcast.id}`
  };
}

module.exports = {
  getAuthUrl,
  setTokensFromCode,
  setStoredCredentials,
  refreshAccessTokenIfNeeded,
  createLiveBroadcast,
  createLiveStream,
  bindBroadcastToStream,
  transitionToLive,
  transitionToComplete,
  createAndGoLive,
  oauth2Client
};
