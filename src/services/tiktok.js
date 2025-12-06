const axios = require('axios');

class TikTokService {
    async extract(url) {
        // STRATEGY 1: TikWM (Rich Data, Slideshow support)
        try {
            console.log(`🎵 TikTok Service (TikWM): ${url}`);
            const { data } = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);

            if (data && data.code === 0) {
                const v = data.data;
                // Slideshow
                if (v.images && v.images.length > 0) {
                    return {
                        type: 'gallery',
                        title: v.title || 'TikTok Slideshow',
                        source: url,
                        items: v.images.map(img => ({ type: 'image', url: img }))
                    };
                }
                // Video
                return {
                    type: 'video',
                    title: v.title || 'TikTok Video',
                    source: url,
                    url: v.play, // HD No-Watermark
                    cover: v.cover
                };
            }
        } catch (e) { console.log("⚠️ TikWM failed, trying fallback..."); }

        // STRATEGY 2: Cobalt (Fallback)
        try {
            console.log(`🎵 TikTok Service (Cobalt): ${url}`);
            const { data } = await axios.post('https://api.cobalt.tools/api/json', {
                url: url
            }, {
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
            });

            if (data.url) {
                return {
                    type: 'video',
                    title: 'TikTok Video',
                    source: url,
                    url: data.url
                };
            }
        } catch (e) { console.error("TikTok Fallback Error:", e.message); }

        return null;
    }
}

module.exports = new TikTokService();