const axios = require('axios');
const downloader = require('../utils/downloader');

class TwitterService {
    async extract(url) {
        try {
            // 1. Use FxTwitter API for Metadata
            const apiUrl = url.replace(/(twitter\.com|x\.com)/, 'api.fxtwitter.com');
            const { data } = await axios.get(apiUrl, { timeout: 5000 });
            const tweet = data.tweet;

            if (!tweet || !tweet.media) return null;

            // CAPTURE AUTHOR HERE
            const authorName = tweet.author?.name || tweet.user?.name || 'Twitter User';

            const baseInfo = {
                title: tweet.text || 'Twitter Media',
                author: authorName, // Added Author
                source: url,
                type: 'video' // default
            };

            // A. Gallery
            if (tweet.media.all && tweet.media.all.length > 1) {
                return {
                    ...baseInfo,
                    type: 'gallery',
                    items: tweet.media.all.map(m => ({ 
                        type: m.type === 'video' ? 'video' : 'image', 
                        url: m.url 
                    }))
                };
            }

            // B. Single Image
            if (tweet.media.photos && tweet.media.photos.length > 0) {
                return { ...baseInfo, type: 'image', url: tweet.media.photos[0].url };
            }

            // C. Single Video
            if (tweet.media.videos && tweet.media.videos.length > 0) {
                const videoData = {
                    ...baseInfo,
                    type: 'video',
                    url: tweet.media.videos[0].url 
                };

                try {
                    const info = await downloader.getInfo(url);
                    videoData.formats = info.formats; 
                } catch (e) {
                    console.log("⚠️ Twitter Quality Check Failed. Falling back to Direct Link.");
                }
                return videoData;
            }
        } catch (e) {
            console.error("Twitter Service Error:", e.message);
            return null;
        }
    }
}

module.exports = new TwitterService();