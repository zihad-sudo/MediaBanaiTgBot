const axios = require('axios');

class TikTokService {
    async extract(url) {
        try {
            console.log(`🎵 TikTok Service: ${url}`);
            
            // TikWM API (Best for No-Watermark & Slideshows)
            const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
            const { data } = await axios.get(apiUrl);

            if (!data || data.code !== 0) {
                console.log("⚠️ TikWM failed. Using fallback.");
                return null;
            }

            const v = data.data;

            // 1. Slideshow (Gallery)
            if (v.images && v.images.length > 0) {
                return {
                    type: 'gallery',
                    title: v.title || 'TikTok Slideshow',
                    source: url,
                    items: v.images.map(img => ({ type: 'image', url: img }))
                };
            }

            // 2. Video
            return {
                type: 'video',
                title: v.title || 'TikTok Video',
                source: url,
                url: v.play, // Direct HD Link
                cover: v.cover
            };

        } catch (e) {
            console.error("TikTok Error:", e.message);
            return null;
        }
    }
}

module.exports = new TikTokService();