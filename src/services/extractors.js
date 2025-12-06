const axios = require('axios');
const config = require('../config/settings');

// Import all services
const twitterService = require('./twitter');
const redditService = require('./reddit');
const instagramService = require('./instagram');
const tiktokService = require('./tiktok');
const musicService = require('./music'); // We will create this next

const resolveRedirect = async (url) => {
    // Skip TikTok/Shorts
    if (!url.includes('/s/') && !url.includes('vm.tiktok') && !url.includes('vt.tiktok')) return url;
    try {
        const res = await axios.head(url, {
            maxRedirects: 0,
            validateStatus: s => s >= 300 && s < 400,
            headers: { 'User-Agent': config.UA_ANDROID }
        });
        return res.headers.location || url;
    } catch (e) { return url; }
};

class MediaExtractor {
    async extract(url) {
        const fullUrl = await resolveRedirect(url);
        
        // 1. Twitter / X
        if (fullUrl.includes('x.com') || fullUrl.includes('twitter.com')) {
            return twitterService.extract(fullUrl);
        } 
        
        // 2. Reddit
        else if (fullUrl.includes('reddit.com') || fullUrl.includes('redd.it')) {
            return redditService.extract(fullUrl);
        }
        
        // 3. Instagram
        else if (fullUrl.includes('instagram.com')) {
            return instagramService.extract(fullUrl);
        }

        // 4. TikTok
        else if (fullUrl.includes('tiktok.com')) {
            return tiktokService.extract(fullUrl);
        }

        // 5. Music (Spotify/SoundCloud)
        else if (fullUrl.includes('spotify.com') || fullUrl.includes('soundcloud.com')) {
            return musicService.extract(fullUrl);
        }

        return null;
    }
}

module.exports = new MediaExtractor();