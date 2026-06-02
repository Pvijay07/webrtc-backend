FROM node:20

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Start the server
CMD ["node", "server.js"]
