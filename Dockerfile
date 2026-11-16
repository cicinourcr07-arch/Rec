FROM node:22-bookworm-slim

# Install FFmpeg, FFprobe, and fontconfig/fonts required for video analysis,
# audio extraction, subtitle burn-in (libass), and MP4 rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY tsconfig.json server.ts ./
COPY server ./server
COPY src ./src

# Default persistent storage directory (mounted as a Render Persistent Disk)
ENV NODE_ENV=production \
    PORT=10000 \
    STORAGE_DIR=/var/data/recap-studio \
    MAX_UPLOAD_SIZE_MB=2048 \
    TEMP_RETENTION_HOURS=24

RUN mkdir -p /var/data/recap-studio

EXPOSE 10000

CMD ["npm", "start"]
