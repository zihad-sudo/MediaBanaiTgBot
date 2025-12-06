const axios = require('axios');

class InstagramService {
    async extract(url) {
        try {
            console.log(`📸 Instagram Service: ${url}`);
            
            // Use Cobalt API (Stable Public Instance)
            // It bypasses the 403/Login blocks that yt-dlp faces
            const { data } = await axios.post('https://api.cobalt.tools/api/json', {
                url: url,
                vCodec: 'h264',
                vQuality: '720'
            }, {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (data.status === 'error' || !data.url) {
                // If main API fails, return null (Controller will handle error)
                console.error("Instagram API Error:", data.text);
                return null;
            }

            const result = {
                title: 'Instagram Media',
                source: url,
                formats: []
            };

            // Detect Type based on what Cobalt returns
            // Cobalt returns a 'picker' array for galleries
            if (data.picker) {
                result.type = 'gallery';
                result.items = data.picker.map(item => ({
                    type: item.type === 'photo' ? 'image' : 'video',
                    url: item.url
                }));
            } 
            // Single Item
            else {
                // Determine if it's a video or image based on URL extension or type field
                const isVideo = data.url.includes('.mp4') || data.type === 'video'; // Cobalt doesn't always send 'type'
                
                result.type = isVideo ? 'video' : 'image';
                result.url = data.url;
            }

            return result;

        } catch (e) {
            console.error("Instagram Service Error:", e.message);
            return null;
        }
    }
}

module.exports = new InstagramService();