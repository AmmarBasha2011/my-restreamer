# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg curl &&     curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp &&     chmod a+rx /usr/local/bin/yt-dlp

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install any needed packages
RUN npm install

# Bundle app source
COPY . .

# Make port 3000 available to the world outside this container
EXPOSE 3000

# Define the command to run your app
CMD [ "npm", "start" ]
