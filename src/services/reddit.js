const axios = require('axios');
const config = require('../config/settings');

class RedditService {
    async extract(url) {
        let pathName = "";
        try { pathName = new URL(url).pathname; } catch(e) { return null; }

        // ============================================================
        // STRATEGY 1: DIRECT REDDIT API (Android Identity)
        // ============================================================
        try {
            const cleanUrl = url.split('?')[0];
            const jsonUrl = cleanUrl.replace(/\/$/, '') + '.json';
            
            console.log(`🕵️ Trying Direct Reddit API: ${jsonUrl}`);
            
            const { data } = await axios.get(jsonUrl, {
                timeout: 5000,
                headers: { 'User-Agent': config.UA_ANDROID }
            });

            if (data && data[0] && data[0].data) {
                console.log("✅ Direct API Success");
                return this.parseRedditData(data[0].data.children[0].data, url);
            }
        } catch (e) {
            console.log(`⚠️ Direct API failed. Switching to Mirrors...`);
        }

        // ============================================================
        // STRATEGY 2: MIRROR ROTATION
        // ============================================================
        for (const domain of config.REDDIT_MIRRORS) {
            try {
                let mirrorUrl = `${domain}${pathName}`.replace(/\/+/g, '/').replace('https:/', 'https://'); 
                if (!mirrorUrl.endsWith('.json')) mirrorUrl += ".json";

                console.log(`🌐 Trying Mirror: ${domain}`);
                
                const { data } = await axios.get(mirrorUrl, {
                    timeout: 6000,
                    headers: { 'User-Agent': config.UA_ANDROID }
                });

                if (data && data[0] && data[0].data) {
                    return this.parseRedditData(data[0].data.children[0].data, url);
                }

            } catch (e) { continue; } 
        }
        
        // ============================================================
        // STRATEGY 3: ULTIMATE FALLBACK (The v10 "Shameless" Mode)
        // If all APIs fail, we assume it's a video and let yt-dlp try directly.
        // This prevents "Media not found" errors.
        // ============================================================
        console.log("⚠️ All APIs failed. Returning raw URL for yt-dlp fallback.");
        return {
            title: 'Reddit Media (Fallback)',
            source: url,
            type: 'video',
            url: url // Send original URL to yt-dlp
        };
    }

    // --- PARSER LOGIC ---
    parseRedditData(post, sourceUrl) {
        const baseInfo = { title: post.title || 'Reddit Media', source: sourceUrl };

        // 1. Gallery
        if (post.is_gallery && post.media_metadata) {
            const items = [];
            const ids = post.gallery_data?.items || [];
            ids.forEach(item => {
                const meta = post.media_metadata[item.media_id];
                if (meta && meta.status === 'valid') {
                    let u = meta.s.u ? meta.s.u.replace(/&amp;/g, '&') : meta.s.gif;
                    if (meta.e === 'Video' && meta.s.mp4) {
                        u = meta.s.mp4.replace(/&amp;/g, '&');
                    }
                    items.push({ type: 'image', url: u });
                }
            });
            return { ...baseInfo, type: 'gallery', items };
        }

        // 2. Video (Hosted on Reddit - v.redd.it)
        if (post.secure_media && post.secure_media.reddit_video) {
            return {
                ...baseInfo,
                type: 'video',
                // Direct Link Bypasses 403
                url: post.secure_media.reddit_video.fallback_url.split('?')[0]
            };
        }

        // 3. Image / GIF
        if (post.url && (post.url.match(/\.(jpeg|jpg|png|gif)$/i) || post.post_hint === 'image')) {
            return { ...baseInfo, type: 'image', url: post.url };
        }

        // 4. EXTERNAL MEDIA (RedGifs, Imgur, etc.) - The Missing Piece!
        // If we have a URL but it didn't match the above, we treat it as a video target.
        if (post.url) {
            console.log(`🔗 Found External Link: ${post.url}`);
            return {
                ...baseInfo,
                type: 'video', // Treat as video so yt-dlp handles it
                url: post.url
            };
        }

        return null;
    }
}

module.exports = new RedditService();
