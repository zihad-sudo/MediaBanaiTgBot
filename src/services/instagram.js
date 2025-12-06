const downloader = require('../utils/downloader');

class InstagramService {
    async extract(url) {
        try {
            console.log(`📸 Instagram Service (yt-dlp): ${url}`);
            
            // Use the internal downloader (yt-dlp)
            // This worked before, so we are going back to it.
            const info = await downloader.getInfo(url);

            const result = {
                title: info.title || 'Instagram Media',
                source: url,
                formats: info.formats || []
            };

            // 1. Carousel / Gallery (Multiple items)
            if (info._type === 'playlist' && info.entries) {
                const items = info.entries.map(entry => ({
                    // Check extension or URL to determine type
                    type: (entry.ext === 'mp4' || entry.url.includes('.mp4')) ? 'video' : 'image',
                    url: entry.url
                }));
                return { ...result, type: 'gallery', items };
            }

            // 2. Single Video
            if (info.ext === 'mp4' || (info.url && info.url.includes('.mp4'))) {
                return {
                    ...result,
                    type: 'video',
                    url: info.url // Direct Video Link
                };
            }

            // 3. Single Image
            // yt-dlp puts the direct image URL in 'url'
            if (info.url) {
                return {
                    ...result,
                    type: 'image',
                    url: info.url
                };
            }

            return null;

        } catch (e) {
            console.error("Instagram Error:", e.message);
            return null;
        }
    }
}

module.exports = new InstagramService();