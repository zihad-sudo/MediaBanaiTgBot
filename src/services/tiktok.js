const downloader = require('../utils/downloader');

class TikTokService {
    async extract(url) {
        try {
            console.log(`🎵 TikTok Service: ${url}`);
            const info = await downloader.getInfo(url);

            return {
                type: 'video',
                title: info.title || 'TikTok Video',
                source: url,
                url: info.url, // yt-dlp usually gets the unwatermarked link
                formats: info.formats || []
            };

        } catch (e) {
            console.error("TikTok Error:", e.message);
            return null;
        }
    }
}

module.exports = new TikTokService();