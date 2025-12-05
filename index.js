require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const axios = require('axios');

const execPromise = util.promisify(exec);

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

// --- 1. COOKIE LOADER ---
const cookiePath = path.join(__dirname, 'cookies.txt');
if (process.env.REDDIT_COOKIES) {
    let rawData = process.env.REDDIT_COOKIES;
    rawData = rawData.replace(/\\n/g, '\n').replace(/ /g, '\t').replace(/#HttpOnly_/g, '');
    if (!rawData.startsWith('# Netscape')) rawData = "# Netscape HTTP Cookie File\n" + rawData;
    fs.writeFileSync(cookiePath, rawData);
    console.log("✅ Cookies loaded.");
}

const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- UTILITIES ---

const resolveRedirect = async (shortUrl) => {
    if (!shortUrl.includes('/s/')) return shortUrl;
    try {
        const res = await axios.head(shortUrl, {
            maxRedirects: 0,
            validateStatus: (s) => s >= 300 && s < 400,
            headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K)' }
        });
        return res.headers.location || shortUrl;
    } catch (e) { return shortUrl; }
};

const runYtDlp = async (url) => {
    let cmd = `yt-dlp --force-ipv4 --no-warnings --no-playlist -J "${url}"`;
    if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;
    return await execPromise(cmd);
};

// --- UNIVERSAL MEDIA PARSER ---
const fetchMediaDetails = async (postUrl) => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    // --- A. TWITTER / X LOGIC ---
    if (postUrl.includes('x.com') || postUrl.includes('twitter.com')) {
        try {
            // 1. Use API to identify type (Image vs Video vs Gallery)
            const apiUrl = postUrl.replace(/(twitter\.com|x\.com)/, 'api.fxtwitter.com');
            console.log(`🐦 Twitter API Check: ${apiUrl}`);
            
            const { data } = await axios.get(apiUrl, { timeout: 5000 });
            const tweet = data.tweet;

            if (!tweet || !tweet.media) return null;

            const media = tweet.media;

            // CASE: Gallery
            if (media.all && media.all.length > 1) {
                const items = media.all.map(m => ({
                    type: m.type === 'video' ? 'video' : 'image',
                    url: m.url
                }));
                return { type: 'gallery', title: tweet.text || 'Gallery', items: items, source: postUrl };
            }

            // CASE: Single Image
            if (media.photos && media.photos.length > 0) {
                return { type: 'image', title: tweet.text || 'Image', url: media.photos[0].url, source: postUrl };
            }

            // CASE: Single Video (CRITICAL: Fetch Formats for Quality Choice)
            if (media.videos && media.videos.length > 0) {
                console.log("🎥 Twitter Video detected. Fetching qualities via yt-dlp...");
                // We intentionally run yt-dlp here to populate the 'formats' list
                // This enables the 360p/720p buttons
                const { stdout } = await runYtDlp(postUrl);
                const info = JSON.parse(stdout);
                
                return {
                    type: 'video',
                    title: tweet.text || 'Video',
                    formats: info.formats, // Pass formats to handler
                    url: media.videos[0].url, // Default fallback
                    source: postUrl
                };
            }

        } catch (e) {
            console.error("Twitter API Error:", e.message);
            // Fallback: If API fails, return null and let the main handler try raw yt-dlp
            return null;
        }
    }

    // --- B. REDDIT LOGIC ---
    const cleanUrl = postUrl.split('?')[0];
    const jsonUrl = cleanUrl.replace(/\/$/, '') + '.json';

    try {
        console.log(`🕵️ Reddit API: ${jsonUrl}`);
        const { data } = await axios.get(jsonUrl, {
            timeout: 5000,
            headers: { 'User-Agent': ua }
        });

        const post = data[0].data.children[0].data;

        // 1. Gallery
        if (post.is_gallery && post.media_metadata) {
            const items = [];
            const ids = post.gallery_data?.items || [];
            ids.forEach(item => {
                const meta = post.media_metadata[item.media_id];
                if (meta.status === 'valid') {
                    let mediaUrl = meta.s.u ? meta.s.u.replace(/&amp;/g, '&') : meta.s.gif;
                    if (meta.e === 'Video') mediaUrl = meta.s.mp4 ? meta.s.mp4.replace(/&amp;/g, '&') : mediaUrl;
                    items.push({ type: 'image', url: mediaUrl });
                }
            });
            return { type: 'gallery', title: post.title, items: items, source: postUrl };
        }

        // 2. Video
        if (post.secure_media && post.secure_media.reddit_video) {
            return {
                type: 'video',
                title: post.title,
                url: post.secure_media.reddit_video.hls_url || post.secure_media.reddit_video.fallback_url,
                source: postUrl
            };
        }

        // 3. Image
        if (post.url && (post.url.match(/\.(jpeg|jpg|png|gif)$/i) || post.post_hint === 'image')) {
            return { type: 'image', title: post.title, url: post.url, source: postUrl };
        }

        return null;
    } catch (e) {
        console.error("Reddit Parse Error:", e.message);
        return null;
    }
};

const downloadVideo = async (url, isAudio, outputPath) => {
    let cmd = `yt-dlp --force-ipv4 --no-warnings`;
    if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;

    if (isAudio) {
        cmd += ` -x --audio-format mp3 -o "${outputPath}.%(ext)s" "${url}"`;
    } else {
        const fmt = "best"; // Default for direct links
        cmd += ` -f "${fmt}" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`;
    }
    return await execPromise(cmd);
};

// --- HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Ready! Send links."));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(URL_REGEX);
    if (!match) return;

    const msg = await ctx.reply("🔍 *Analyzing Media...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const originalUrl = match[0];
        const fullUrl = await resolveRedirect(originalUrl);
        
        // 1. Determine Type
        let mediaData = await fetchMediaDetails(fullUrl);
        let info = { title: 'Media' };
        
        // If fetchMediaDetails returned formats (Twitter Video), attach them to info
        if (mediaData && mediaData.formats) {
            info.formats = mediaData.formats;
        }

        // Fallback: If custom parser failed, try raw yt-dlp (e.g. for unknown sites)
        if (!mediaData) {
            const { stdout } = await runYtDlp(fullUrl);
            info = JSON.parse(stdout);
            mediaData = { type: 'video', url: fullUrl }; 
        } else {
            info.title = mediaData.title || 'Media';
        }

        const buttons = [];
        let displayText = `✅ *${(info.title).substring(0, 50)}...*`;

        // 2. Build Buttons
        if (mediaData.type === 'gallery') {
            displayText += `\n\n📚 **Album Found:** ${mediaData.items.length} items`;
            buttons.push([Markup.button.callback(`📥 Download Album (${mediaData.items.length})`, `alb|all|all`)]);
        } 
        else if (mediaData.type === 'image') {
            displayText += `\n\n🖼 **Single Image Detected**`;
            buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single|single`)]);
        } 
        else {
            // VIDEO Logic (Reddit + Twitter)
            if (info.formats && info.formats.length > 0) {
                // Filter for MP4 videos with height
                const formats = info.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height);
                const seen = new Set();
                
                formats.slice(0, 5).forEach(f => {
                    if(!seen.has(f.height)) {
                        seen.add(f.height);
                        // Store Format ID
                        buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}|${f.height}`)]);
                    }
                });
            } 
            
            // If no formats found (e.g. Direct Reddit Link), fallback to "Best"
            if (buttons.length === 0) {
                buttons.push([Markup.button.callback("📹 Download Video", `vid|direct|best`)]);
            }
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|direct|audio")]);
        }

        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `${displayText}\nSource: [Link](${fullUrl})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error("Handler Error:", err.message);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Content private or unavailable.");
    }
});

bot.on('callback_query', async (ctx) => {
    const [action, id, label] = ctx.callbackQuery.data.split('|');
    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    if (!url) return ctx.answerCbQuery("❌ Link expired.");

    if (action === 'img') {
        await ctx.answerCbQuery("🚀 Sending Image...");
        const media = await fetchMediaDetails(url);
        const imgUrl = media?.url || url;
        try { await ctx.replyWithPhoto(imgUrl); } 
        catch(e) { await ctx.replyWithDocument(imgUrl); }
        await ctx.deleteMessage();
    } 
    else if (action === 'alb') {
        await ctx.answerCbQuery("🚀 Processing Album...");
        await ctx.editMessageText(`⏳ *Fetching Album...*`, { parse_mode: 'Markdown' });
        const media = await fetchMediaDetails(url);
        if (media && media.type === 'gallery') {
             await ctx.editMessageText(`📤 *Sending ${media.items.length} items...*`, { parse_mode: 'Markdown' });
             for (const item of media.items) {
                 try {
                     if (item.type === 'video') await ctx.replyWithVideo(item.url);
                     else await ctx.replyWithDocument(item.url);
                 } catch (e) {}
             }
             await ctx.deleteMessage();
        } else {
            await ctx.editMessageText("❌ Gallery Error.");
        }
    } 
    else {
        // VIDEO DOWNLOAD
        await ctx.answerCbQuery("🚀 Downloading...");
        await ctx.editMessageText(`⏳ *Downloading...*`, { parse_mode: 'Markdown' });

        const timestamp = Date.now();
        const basePath = path.join(downloadDir, `${timestamp}`);
        const finalFile = `${basePath}.${action === 'aud' ? 'mp3' : 'mp4'}`;

        try {
            if (id === 'direct') {
                await downloadVideo(url, action === 'aud', basePath);
            } else {
                // Download specific format (works for Reddit & Twitter)
                let cmd = `yt-dlp --force-ipv4 --no-warnings`;
                if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;
                const fmt = `${id}+bestaudio/best`;
                cmd += ` -f "${fmt}" --merge-output-format mp4 -o "${basePath}.%(ext)s" "${url}"`;
                await execPromise(cmd);
            }

            const stats = fs.statSync(finalFile);
            if (stats.size > 49.5 * 1024 * 1024) {
                await ctx.editMessageText("⚠️ File > 50MB.");
            } else {
                await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
                action === 'aud' 
                    ? await ctx.replyWithAudio({ source: finalFile })
                    : await ctx.replyWithVideo({ source: finalFile });
                await ctx.deleteMessage();
            }
        } catch (e) {
            console.error("DL Error:", e);
            await ctx.editMessageText("❌ Download Error.");
        } finally {
            if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
        }
    }
});

// --- SERVER ---
app.get('/', (req, res) => res.send('✅ Bot Online v9'));
if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${APP_URL}/bot`);
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));
} else {
    bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
