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
    // Repair Render's mangled newlines
    rawData = rawData.replace(/\\n/g, '\n').replace(/ /g, '\t');
    rawData = rawData.replace(/#HttpOnly_/g, ''); 
    if (!rawData.startsWith('# Netscape')) rawData = "# Netscape HTTP Cookie File\n" + rawData;
    fs.writeFileSync(cookiePath, rawData);
    console.log("✅ Cookies loaded.");
}

const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- UTILITIES ---

// 1. Resolve Redirects (/s/ links)
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

// 2. THE BYPASS: Fetch JSON Metadata Manually
// We use this to find the direct HLS/DASH link so yt-dlp doesn't have to visit the blocked webpage.
const fetchDirectMediaUrl = async (postUrl) => {
    const cleanUrl = postUrl.split('?')[0];
    // We try multiple endpoints to get the JSON
    const endpoints = [
        `${cleanUrl}.json`, // Standard
        cleanUrl.replace('www.reddit.com', 'old.reddit.com') + '.json', // Old Reddit
        cleanUrl.replace('reddit.com', 'api.reddit.com') + '.json' // API subdomain
    ];

    for (const url of endpoints) {
        try {
            console.log(`🕵️ Fetching Metadata: ${url}`);
            const { data } = await axios.get(url, {
                timeout: 5000,
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                }
            });

            const post = data[0].data.children[0].data;

            // STRATEGY: Find the HLS (m3u8) Link. This contains video AND audio.
            if (post.secure_media && post.secure_media.reddit_video) {
                return {
                    title: post.title,
                    // hls_url is best, fallback to dash_url, fallback to fallback_url
                    url: post.secure_media.reddit_video.hls_url || post.secure_media.reddit_video.dash_url || post.secure_media.reddit_video.fallback_url,
                    is_video: true
                };
            }
            // Image/Gif
            if (post.url && (post.url.includes('i.redd.it') || post.url.includes('v.redd.it'))) {
                return { title: post.title, url: post.url, is_video: true };
            }
        } catch (e) {
            // If 403, try next endpoint
            console.log(`⚠️ Endpoint failed (${e.response?.status || e.message}), trying next...`);
        }
    }
    return null;
};

// 3. Downloader
const runYtDlp = async (url) => {
    let cmd = `yt-dlp --force-ipv4 --no-warnings --no-playlist -J "${url}"`;
    if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;
    return await execPromise(cmd);
};

const downloadDirect = async (url, isAudio, outputPath) => {
    // We download the HLS/Direct link directly. No webpage scraping.
    let cmd = `yt-dlp --force-ipv4 --no-warnings`;
    
    // Cookies not needed for HLS links usually, but good to have
    if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;

    if (isAudio) {
        cmd += ` -x --audio-format mp3 -o "${outputPath}.%(ext)s" "${url}"`;
    } else {
        // Just download best available from the direct link
        cmd += ` -f "best" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`;
    }
    return await execPromise(cmd);
};

// --- HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Ready! Using Direct API Extraction."));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(URL_REGEX);
    if (!match) return;

    const msg = await ctx.reply("🔍 *Bypassing Webpage...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const originalUrl = match[0];
        let fullUrl = await resolveRedirect(originalUrl);
        
        let info = {};
        let directLink = null;

        // STRATEGY A: Try Standard yt-dlp first (Best for Twitter/X)
        if (fullUrl.includes('x.com') || fullUrl.includes('twitter.com')) {
             const { stdout } = await runYtDlp(fullUrl);
             info = JSON.parse(stdout);
             directLink = fullUrl;
        } 
        // STRATEGY B: Manual JSON Extraction (For Reddit)
        else {
             console.log("🚀 Activating Reddit Bypass...");
             const mediaData = await fetchDirectMediaUrl(fullUrl);
             
             if (mediaData) {
                 console.log("✅ Found Direct Link:", mediaData.url);
                 info = { 
                     title: mediaData.title, 
                     formats: [] // Dummy formats, we don't need them for direct DL
                 };
                 directLink = mediaData.url;
             } else {
                 // Fallback: Let yt-dlp try its best with cookies
                 const { stdout } = await runYtDlp(fullUrl);
                 info = JSON.parse(stdout);
                 directLink = fullUrl;
             }
        }

        // Buttons
        const buttons = [];
        // If we have detailed formats (Twitter), show them
        if (info.formats && info.formats.length > 0) {
            const formats = info.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height);
            const seen = new Set();
            formats.slice(0, 5).forEach(f => {
                if(!seen.has(f.height)) {
                    seen.add(f.height);
                    buttons.push([Markup.button.callback(`📹 ${f.height}p`, `v|${f.format_id}|${f.height}`)]);
                }
            });
        }
        
        // If no formats (Direct Reddit Link), show generic button
        if (buttons.length === 0) {
            buttons.push([Markup.button.callback("📹 Download Video", `v|direct|best`)]);
        }
        buttons.push([Markup.button.callback("🎵 Audio Only", "a|direct|audio")]);

        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `✅ *${(info.title || 'Media Found').substring(0, 50)}...*\nSource: [Link](${directLink})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error("Handler Error:", err.message);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Reddit blocked the request.");
    }
});

bot.on('callback_query', async (ctx) => {
    const [type, id, label] = ctx.callbackQuery.data.split('|');
    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    if (!url) return ctx.answerCbQuery("❌ Link expired.");

    await ctx.answerCbQuery("🚀 Downloading...");
    await ctx.editMessageText(`⏳ *Downloading...*`, { parse_mode: 'Markdown' });

    const timestamp = Date.now();
    const basePath = path.join(downloadDir, `${timestamp}`);
    const finalFile = `${basePath}.${type === 'a' ? 'mp3' : 'mp4'}`;

    try {
        if (id === 'direct') {
            // Direct Link Mode (Bypasses webpage)
            await downloadDirect(url, type === 'a', basePath);
        } else {
            // Standard Mode (Twitter)
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
            type === 'a' 
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
});

app.get('/', (req, res) => res.send('✅ Bot Online'));
if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${APP_URL}/bot`);
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));
} else {
    bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
