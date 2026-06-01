FROM node:20

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Environment variables
ENV PORT=3000

# Expose HTTP port and WebRTC UDP ports (10000-10100 for testing, change if needed)
EXPOSE 3000
EXPOSE 10000-10100/udp

# Start the server
CMD ["npm", "start"]
