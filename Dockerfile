FROM node:20

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Expose port 3000 for Railway HTTP routing
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
