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
// FIX: Renamed variable to avoid breaking the code
const SERVER_URL = process.env.RENDER_EXTERNAL_URL; 
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

// List of Public Mirrors (These bypass the Reddit 403 Block)
const MIRRORS = [
    'https://redlib.catsarch.com',
    'https://redlib.vlingit.com',
    'https://redlib.tux.pizza',
    'https://libreddit.kavin.rocks'
];

const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- UTILITIES ---

// 1. Resolve /s/ Short Links
const resolveRedirect = async (shortUrl) => {
    if (!shortUrl.includes('/s/')) return shortUrl;
    try {
        const res = await axios.head(shortUrl, {
            maxRedirects: 0,
            validateStatus: (s) => s >= 300 && s < 400,
            headers: { 'User-Agent': 'Mozilla/5.0 (Android 10; Mobile)' }
        });
        return res.headers.location || shortUrl;
    } catch (e) {
        return shortUrl;
    }
};

// 2. Mirror Strategy: Get the direct video link (v.redd.it) without touching reddit.com
const getMediaFromMirror = async (originalUrl) => {
    try {
        // Parse the URL safely
        const parsed = new URL(originalUrl); 
        const path = parsed.pathname; // e.g. /r/funny/comments/...

        // Try mirrors one by one
        for (const domain of MIRRORS) {
            try {
                // We request the JSON data from the mirror
                const mirrorApi = `${domain}${path}.json`;
                console.log(`🛡️ Checking Mirror: ${mirrorApi}`);

                const { data } = await axios.get(mirrorApi, {
                    timeout: 6000,
                    headers: { 'User-Agent': 'GoogleBot' }
                });

                const post = data[0].data.children[0].data;

                // Check for Video
                if (post.is_video && post.media && post.media.reddit_video) {
                    return {
                        title: post.title,
                        // Clean the URL to ensure it's the direct file
                        url: post.media.reddit_video.fallback_url.split('?')[0],
                        is_video: true
                    };
                }
                // Check for Image/GIF
                if (post.url && (post.url.includes('i.redd.it') || post.url.includes('v.redd.it'))) {
                    return { title: post.title, url: post.url, is_video: true };
                }

            } catch (innerErr) {
                console.log(`⚠️ Mirror ${domain} failed, trying next...`);
            }
        }
    } catch (e) {
        console.error("Critical Mirror Error:", e.message);
    }
    return null;
};

// 3. Downloader
const runYtDlp = async (url) => {
    // Standard download command
    const cmd = `yt-dlp --force-ipv4 --no-warnings --no-playlist -J "${url}"`;
    return await execPromise(cmd);
};

// --- HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Ready! Send me a link."));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(URL_REGEX);
    if (!match) return;

    const msg = await ctx.reply("🔍 *Processing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        // Step 1: Expand Short Link
        let targetUrl = await resolveRedirect(match[0]);
        let downloadUrl = targetUrl; // Default
        let info = {};

        // Step 2: Decide Strategy
        if (targetUrl.includes('reddit.com')) {
            console.log("🕵️ Activating Mirror Bypass for Reddit...");
            const mirrorData = await getMediaFromMirror(targetUrl);
            
            if (mirrorData) {
                console.log("✅ Mirror Success:", mirrorData.url);
                downloadUrl = mirrorData.url;
                info = { title: mirrorData.title, formats: [], extractor_key: 'Mirror' };
            } else {
                // If mirrors fail, try direct (might fail, but worth a shot)
                const { stdout } = await runYtDlp(targetUrl);
                info = JSON.parse(stdout);
            }
        } else {
            // Twitter/X usually works direct
            const { stdout } = await runYtDlp(targetUrl);
            info = JSON.parse(stdout);
        }

        // Step 3: Buttons
        const buttons = [];
        if (info.formats && info.formats.length > 0) {
            const formats = info.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height);
            const seen = new Set();
            formats.slice(0, 5).forEach(f => {
                if(!seen.has(f.height)) {
                    seen.add(f.height);
                    buttons.push([Markup.button.callback(`📹 ${f.height}p`, `v|${f.format_id}|${f.height}`)]);
                }
            });
        } else {
            // Fallback button for Mirror results
            buttons.push([Markup.button.callback("📹 Download Video", `v|best|best`)]);
        }
        buttons.push([Markup.button.callback("🎵 Audio Only", "a|best|audio")]);

        // Hide safe URL in message
        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `✅ *${(info.title || 'Media Found').substring(0, 50)}...*\nSource: [Link](${downloadUrl})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error("Main Error:", err);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Mirrors are busy or link is invalid.");
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
        let cmd;
        if (type === 'a') {
            cmd = `yt-dlp --force-ipv4 --no-warnings -x --audio-format mp3 -o "${basePath}.%(ext)s" "${url}"`;
        } else {
            const fmt = id === 'best' ? 'best' : `${id}+bestaudio/best`;
            cmd = `yt-dlp --force-ipv4 --no-warnings -f "${fmt}" --merge-output-format mp4 -o "${basePath}.%(ext)s" "${url}"`;
        }

        await execPromise(cmd);

        const stats = fs.statSync(finalFile);
        if (stats.size > 49.5 * 1024 * 1024) {
            await ctx.editMessageText("⚠️ File > 50MB. Telegram limit.");
        } else {
            await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
            type === 'a' 
                ? await ctx.replyWithAudio({ source: finalFile })
                : await ctx.replyWithVideo({ source: finalFile });
            await ctx.deleteMessage();
        }
    } catch (e) {
        console.error("DL Error:", e);
        await ctx.editMessageText("❌ Download Failed.");
    } finally {
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
    }
});

// --- SERVER SETUP ---
app.get('/', (req, res) => res.send('✅ Bot is Alive!'));

if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${SERVER_URL}/bot`);
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
} else {
    bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
