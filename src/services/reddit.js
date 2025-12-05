const axios = require('axios');
const config = require('../config/settings');

class RedditService {
    async extract(url) {
        let pathName = "";
        try { pathName = new URL(url).pathname; } catch(e) { return null; }

        // Mirror Rotation
        for (const domain of config.REDDIT_MIRRORS) {
            try {
                // Construct clean JSON url for Mirror
                const mirrorUrl = `${domain}${pathName}.json`.replace('//.json', '/.json');
                
                const { data } = await axios.get(mirrorUrl, {
                    timeout: 4000,
                    headers: { 'User-Agent': config.UA_ANDROID }
                });

                const post = data[0].data.children[0].data;
                const baseInfo = { title: post.title, source: url };

                // A. Gallery
                if (post.is_gallery && post.media_metadata) {
                    const items = [];
                    const ids = post.gallery_data?.items || [];
                    ids.forEach(item => {
                        const meta = post.media_metadata[item.media_id];
                        if (meta.status === 'valid') {
                            let u = meta.s.u ? meta.s.u.replace(/&amp;/g, '&') : meta.s.gif;
                            if (meta.e === 'Video') u = meta.s.mp4 ? meta.s.mp4.replace(/&amp;/g, '&') : u;
                            items.push({ type: 'image', url: u });
                        }
                    });
                    return { ...baseInfo, type: 'gallery', items };
                }

                // B. Video (Extract Direct Link)
                if (post.secure_media && post.secure_media.reddit_video) {
                    return {
                        ...baseInfo,
                        type: 'video',
                        // Direct HLS/MP4 link bypasses the 403 block on the main site
                        url: post.secure_media.reddit_video.fallback_url.split('?')[0]
                    };
                }

                // C. Image
                if (post.url && (post.url.match(/\.(jpeg|jpg|png|gif)$/i) || post.post_hint === 'image')) {
                    return { ...baseInfo, type: 'image', url: post.url };
                }

            } catch (e) { continue; } // Mirror failed, try next
        }
        return null;
    }
}

module.exports = new RedditService();
