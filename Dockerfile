FROM node:18-slim

# Install ffmpeg, curl, and python (for yt-dlp)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

# Create playlists directory
RUN mkdir -p playlists

EXPOSE 3000

CMD ["npm", "start"]
