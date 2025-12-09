# Use Debian Bullseye (Stable Internet)
FROM node:18-bullseye

# Install Python & FFmpeg
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg

# Install yt-dlp (Standard command for Bullseye)
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install yt-dlp

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

# Hugging Face Spaces requires Port 7860
ENV PORT=7860
EXPOSE 7860

CMD [ "npm", "start" ]