FROM node:18-alpine

# Install Python & FFmpeg for yt-dlp
RUN apk add --no-cache python3 py3-pip ffmpeg

# Install yt-dlp globally
RUN python3 -m pip install --upgrade pip --break-system-packages \
    && python3 -m pip install yt-dlp --break-system-packages

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD [ "npm", "start" ]
