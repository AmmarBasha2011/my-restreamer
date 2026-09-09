<div align="center">

# 🚀 Advanced Restreamer

### Multi-Channel Live Streaming Platform with 24/7 & Scheduled Non-24 Broadcasts

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.18-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![YouTube](https://img.shields.io/badge/YouTube_Live_API-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://developers.google.com/youtube/v3/live)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-All_Rights_Reserved-red?style=for-the-badge)](LICENSE)

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#usage">Usage</a> •
  <a href="#api">API</a> •
  <a href="#scheduling">Scheduling</a> •
  <a href="#deployment">Deployment</a> •
  <a href="#license">License</a>
</p>

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Quick Start](#-quick-start)
- [Authentication](#-authentication)
- [Usage](#-usage)
- [Channel Types](#-channel-types)
- [Scheduling (Non-24 Live)](#-scheduling-non-24-live)
- [YouTube API Setup](#-youtube-api-setup)
- [API Reference](#-api-reference)
- [Deployment](#-deployment)
- [Docker](#-docker)
- [Project Structure](#-project-structure)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🌟 Overview

**Advanced Restreamer** is a powerful multi-channel live streaming platform that enables you to broadcast pre-recorded videos to YouTube Live. It supports two modes:

- **📺 24/7 Live** — Continuous looping stream that never stops
- **⏰ Non-24 Live** — Scheduled broadcasts that run at specific times using cron expressions

Perfect for:
- 📖 Quran recitation channels
- 🎙️ Podcast loops
- 🎬 Video playlists
- 📺 24/7 radio/TV stations
- 🎓 Educational content

---

## ✨ Features

### Core Features
- 🔄 **24/7 Looping Stream** — Videos play continuously in sequence
- ⏰ **Cron-based Scheduling** — Schedule broadcasts with flexible cron expressions
- 🎬 **YouTube Live API Integration** — Auto-create broadcasts and go live
- 📤 **Video Upload** — Upload MP4/WebM videos directly
- 📥 **YouTube Download** — Add videos from YouTube URLs via yt-dlp
- 🔑 **Per-Channel Stream Keys** — Each channel has its own YouTube stream key
- 🎨 **Modern UI** — Clean, responsive web interface
- 🔒 **OAuth 2.0** — Secure YouTube authentication with auto token refresh
- 🔐 **Username/Password Authentication** — Secure access to the dashboard

### Advanced Features
- 🛡️ **Self-healing Streams** — Auto-recovery on video errors
- 📊 **Real-time Status** — Live streaming indicators
- 🐳 **Docker Ready** — One-command deployment
- ☁️ **HuggingFace Spaces** — Cloud deployment ready
- 📱 **Responsive Design** — Works on desktop and mobile

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- FFmpeg installed
- YouTube Data API v3 credentials (for Non-24 Live)

### Installation

```bash
# Clone the repository
git clone -b huggingface https://github.com/AmmarBasha2011/my-restreamer.git
cd my-restreamer

# Install dependencies
npm install

# Start the server
npm start
```

Visit `http://localhost:7860` in your browser.

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 7860) | No |
| `USERNAME` | Dashboard login username | Recommended |
| `PASSWORD` | Dashboard login password | Recommended |
| `CLIENT_ID` | Google OAuth Client ID | For Non-24 |
| `CLIENT_SECRET` | Google OAuth Client Secret | For Non-24 |
| `REDIRECT_URI` | OAuth callback URL | For Non-24 |

---

## 🔐 Authentication

The dashboard is protected with username and password authentication. You can set credentials via environment variables.

### Default Credentials
If no environment variables are set:
- **Username:** `admin`
- **Password:** `admin`

> ⚠️ **Important:** Change the default credentials in production!

### Setting Custom Credentials

**Local Development:**
```bash
export USERNAME="myuser"
export PASSWORD="mypassword"
npm start
```

**HuggingFace Space:**
1. Go to your Space Settings
2. Add Repository Secrets:
   - `USERNAME` = your chosen username
   - `PASSWORD` = your chosen password

### Session Management
- Sessions last **24 hours**
- Logout via `/logout` endpoint
- All routes (except login) require authentication

---

## 🎮 Usage

### Creating a 24/7 Channel

1. Click **"+ Add New Channel"**
2. Enter channel name
3. Select **"24/7 Live (Loop)"**
4. Enter YouTube Stream Key
5. Upload videos to the playlist (via file manager or direct upload to the Space)
6. Click **"▶️ Start"**

### Creating a Non-24 Scheduled Channel

1. Click **"+ Add New Channel"**
2. Enter channel name
3. Select **"Non-24 Live (Scheduled)"**
4. Choose **"Run on Schedule (Cron)"**
5. Enter cron expression (e.g., `0 7 * * *` for daily 7 AM)
6. Enter stream title, description, and category
7. Upload videos to the playlist
8. The stream will automatically start at scheduled times

### Connecting YouTube (for Non-24)

1. Click **"Connect YouTube"** in the header
2. Sign in with your Google account
3. Grant the requested permissions
4. You'll be redirected back to the app

---

## 📺 Channel Types

### 24/7 Live (Loop)
```
┌─────────────────────────────────────┐
│  Video 1 → Video 2 → Video 3 → ...  │
│         ↓ (loop forever)            │
│  Video 1 ← Video 2 ← Video 3 ← ...  │
└─────────────────────────────────────┘
```

- Uses YouTube Stream Key directly
- Videos play in sequence, looping forever
- Auto-recovery on errors (skips to next video)
- Best for: Continuous channels, background music, Quran loops

### Non-24 Live (Scheduled)
```
┌─────────────────────────────────────┐
│  Cron Trigger → Create Broadcast    │
│         ↓                           │
│  YouTube API → Go Live              │
│         ↓                           │
│  Play Full Playlist Once            │
│         ↓                           │
│  End Broadcast Automatically        │
└─────────────────────────────────────┘
```

- Uses YouTube Live API to create broadcasts
- Requires YouTube OAuth authentication
- Plays playlist once, then ends
- Best for: Scheduled events, daily Quran sessions, timed broadcasts

---

## ⏰ Scheduling (Non-24 Live)

### Cron Expression Format

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

### Common Examples

| Expression | Description |
|------------|-------------|
| `0 7 * * *` | Daily at 7:00 AM |
| `0 7,12,18 * * *` | Daily at 7 AM, 12 PM, 6 PM |
| `*/30 * * * *` | Every 30 minutes |
| `0 8 * * 1-5` | Weekdays at 8 AM |
| `0 10 * * 5` | Every Friday at 10 AM |
| `0 11 * * 6` | Every Saturday at 11 AM |
| `0 9 */2 * *` | Every 2 days at 9 AM |
| `0 10 */3 * *` | Every 3 days at 10 AM |
| `0 10 1-7 * 5` | First Friday of month at 10 AM |
| `0 23 28-31 * *` | Last day of month at 11 PM |

### YouTube Stream Categories

| ID | Category | Default? |
|----|----------|----------|
| 1 | Film & Animation | |
| 2 | Autos & Vehicles | |
| 10 | Music | ✅ Default |
| 17 | Sports | |
| 19 | Travel & Events | |
| 20 | Gaming | |
| 22 | People & Blogs | |
| 23 | Comedy | |
| 24 | Entertainment | |
| 25 | News & Politics | |
| 26 | Howto & Style | |
| 27 | Education | |
| 28 | Science & Technology | |
| 29 | Nonprofits & Activism | |

---

## 🔑 YouTube API Setup

### Step 1: Create Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one

### Step 2: Enable YouTube Data API v3
1. Navigate to **APIs & Services > Library**
2. Search for "YouTube Data API v3"
3. Click **Enable**

### Step 3: Create OAuth Credentials
1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Select **Web application** as application type
4. Add your redirect URI:
   - Local: `http://localhost:7860/auth/callback`
   - HuggingFace: `https://YOUR_SPACE.hf.space/auth/callback`
5. Copy the **Client ID** and **Client Secret**

### Step 4: Configure OAuth Consent Screen
1. Go to **OAuth consent screen**
2. Select **External** user type
3. Fill in app name and support email
4. Add scopes:
   - `https://www.googleapis.com/auth/youtube`
   - `https://www.googleapis.com/auth/youtube.force-ssl`
   - `https://www.googleapis.com/auth/youtube.upload`

---

## 📡 API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/login` | Login page |
| `POST` | `/api/login` | Submit credentials |
| `GET` | `/logout` | Sign out |

### Destinations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/destinations` | List all channels with playlists |
| `POST` | `/api/destinations` | Create new channel |
| `DELETE` | `/api/destinations/:id` | Delete channel and playlist |

### Playlist Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload/:id` | Upload video to channel |
| `POST` | `/api/playlist/clear/:id` | Clear all videos |
| `POST` | `/api/youtube/add/:id` | Download from YouTube URL |

### Stream Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/stream/start/:id` | Start streaming |
| `POST` | `/api/stream/stop/:id` | Stop streaming |

### Schedule Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `PUT` | `/api/destinations/:id/schedule` | Update channel schedule |

### YouTube Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/auth` | Start OAuth flow |
| `GET` | `/auth/callback` | OAuth callback |
| `GET` | `/api/auth/status` | Check auth status |

---

## 🌐 Deployment

### HuggingFace Spaces (Recommended)

1. Create a new Space with Docker SDK
2. Set environment variables (Repository Secrets):
   - `USERNAME`: Your dashboard username
   - `PASSWORD`: Your dashboard password
   - `CLIENT_ID`: Your Google OAuth Client ID
   - `CLIENT_SECRET`: Your Google OAuth Client Secret
   - `REDIRECT_URI`: `https://YOUR_SPACE.hf.space/auth/callback`
3. Push your code to the Space

> 💡 The default port is **7860** (compatible with HuggingFace)

### VPS/Server

```bash
# Clone and install
git clone -b huggingface https://github.com/AmmarBasha2011/my-restreamer.git
cd my-restreamer
npm install

# Set environment variables
export PORT=7860
export USERNAME="myuser"
export PASSWORD="mypassword"
export CLIENT_ID="your-client-id"
export CLIENT_SECRET="your-client-secret"
export REDIRECT_URI="https://your-domain.com/auth/callback"

# Start
npm start
```

### Using PM2 (Recommended for Production)

```bash
npm install -g pm2
pm2 start app.js --name restreamer
pm2 save
pm2 startup
```

---

## 🐳 Docker

### Build and Run

```bash
# Build image
docker build -t restreamer .

# Run container
docker run -d \
  -p 7860:7860 \
  -e USERNAME="admin" \
  -e PASSWORD="admin" \
  -e CLIENT_ID="your-client-id" \
  -e CLIENT_SECRET="your-client-secret" \
  -e REDIRECT_URI="http://localhost:7860/auth/callback" \
  -v $(pwd)/playlists:/usr/src/app/playlists \
  --name restreamer \
  restreamer
```

### Docker Compose

```yaml
version: '3.8'
services:
  restreamer:
    build: .
    ports:
      - "7860:7860"
    environment:
      - USERNAME=${USERNAME}
      - PASSWORD=${PASSWORD}
      - CLIENT_ID=${CLIENT_ID}
      - CLIENT_SECRET=${CLIENT_SECRET}
      - REDIRECT_URI=${REDIRECT_URI}
    volumes:
      - ./playlists:/usr/src/app/playlists
    restart: unless-stopped
```

---

## 📁 Project Structure

```
my-restreamer/
├── app.js                  # Main server application
├── scheduler.js            # Cron scheduling & Non-24 streaming
├── youtube-api.js          # YouTube OAuth & Live API
├── destinations.json       # Channel configurations
├── package.json            # Dependencies
├── Dockerfile              # Docker configuration
├── LICENSE                 # All Rights Reserved
├── public/
│   └── index.html          # Web interface
└── playlists/
    ├── <channel-id-1>/     # Channel 1 videos
    ├── <channel-id-2>/     # Channel 2 videos
    └── ...
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

This project is **open source and free to use**. All rights are reserved by the author.

### ✅ Permitted (Free of Charge)
- Use the Software for personal, non-commercial purposes
- Study, learn from, and modify the Software for your own use

### ❌ Not Permitted (Without Explicit Written Permission)
- **Distribution** — Sharing, sublicensing, or making the Software available to third parties
- **Commercial Use** — Selling, renting, leasing, or monetizing the Software
- **Public Hosting** — Hosting on platforms accessible to the public

### 📝 Attribution
All copies must include:
> "Advanced Restreamer — Created by Ammar Al-Khateeb (عمار الخطيب)"

### 📧 Contact
For licensing inquiries: **inex.own@gmail.com**

See the [LICENSE](LICENSE) file for full details.

---

## 🙏 Acknowledgments

- [Express.js](https://expressjs.com/) — Web framework
- [express-session](https://github.com/expressjs/session) — Session management
- [node-cron](https://github.com/node-cron/node-cron) — Cron scheduling
- [googleapis](https://github.com/googleapis/google-api-nodejs-client) — YouTube API
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — YouTube video downloader
- [FFmpeg](https://ffmpeg.org/) — Video encoding and streaming

---

<div align="center">

Made with ❤️ by [Ammar Al-Khateeb](https://github.com/AmmarBasha2011)

⭐ Star this repo if you find it helpful!

</div>
