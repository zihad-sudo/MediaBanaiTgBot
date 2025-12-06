const axios = require('axios');

class TikTokService {
    async extract(url) {
        try {
            console.log(`🎵 TikTok Service: ${url}`);
            
            // TikWM API handles short links (vm.tiktok) automatically
            const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
            
            const { data } = await axios.get(apiUrl);

            if (!data || data.code !== 0) {
                console.log("⚠️ TikWM API failed. Link might be invalid.");
                return null;
            }

            const videoData = data.data;

            // 1. Image Slideshow (Gallery)
            if (videoData.images && videoData.images.length > 0) {
                return {
                    type: 'gallery',
                    title: videoData.title || 'TikTok Slideshow',
                    source: url,
                    items: videoData.images.map(img => ({ type: 'image', url: img }))
                };
            }

            // 2. Video (No Watermark)
            return {
                type: 'video',
                title: videoData.title || 'TikTok Video',
                source: url,
                // 'play' is the direct HD link without watermark
                url: videoData.play, 
                cover: videoData.cover
            };

        } catch (e) {
            console.error("TikTok Service Error:", e.message);
            return null;
        }
    }
}

module.exports = new TikTokService();