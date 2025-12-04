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
const URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

// Regex
const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- UTILITIES ---

// 1. Resolve Short Links (/s/)
const resolveRedirect = async (url) => {
    if (!url.includes('/s/')) return url;
    try {
        const res = await axios.head(url, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 300 && status < 400,
            headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10)' }
        });
        return res.headers.location || url;
    } catch (e) {
        return url;
    }
};

// 2. Fallback: Get Direct Video Link via JSON API
// This bypasses the main reddit.com block
const getRedditDirectMap = async (webUrl) => {
    try {
        // Clean URL params
        const cleanUrl = webUrl.split('?')[0];
        const jsonUrl = cleanUrl.endsWith('/') ? `${cleanUrl}.json` : `${cleanUrl}/.json`;
        
        console.log("⚠️ Accessing API:", jsonUrl);
        
        const { data } = await axios.get(jsonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const post = data[0].data.children[0].data;
        
        if (post.secure_media && post.secure_media.reddit_video) {
            // Found a video! v.redd.it links are NOT blocked by 403
            return {
                title: post.title,
                url: post.secure_media.reddit_video.fallback_url,
                is_video: true
            };
        } 
        return null;
    } catch (e) {
        console.error("API Error:", e.message);
        return null;
    }
};

// 3. Downloader
const runYtDlp = async (targetUrl) => {
    const cmd = `yt-dlp --force-ipv4 --no-warnings --no-playlist -J "${targetUrl}"`;
    return await execPromise(cmd);
};

// --- HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Bot Online. Send a link!"));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(URL_REGEX);
    if (!match) return;

    const msg = await ctx.reply("🔍 *Processing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        let url = await resolveRedirect(match[0]);
        let info;
        let directUrl = url;

        // TRY 1: Normal Download
        try {
            const { stdout } = await runYtDlp(url);
            info = JSON.parse(stdout);
        } catch (err) {
            // TRY 2: If Blocked, Use API Fallback
            if (err.stderr && (err.stderr.includes('403') || err.stderr.includes('HTTP Error'))) {
                const apiData = await getRedditDirectMap(url);
                if (apiData && apiData.is_video) {
                    info = { title: apiData.title, formats: [], extractor_key: 'RedditAPI' };
                    directUrl = apiData.url; // This is the unblocked v.redd.it link
                } else {
                    throw err; // Real error
                }
            } else {
                throw err;
            }
        }

        // Generate Buttons
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
            // Fallback Button (Downloads 'best' from direct link)
            buttons.push([Markup.button.callback("📹 Download Video", `v|best|best`)]);
        }
        buttons.push([Markup.button.callback("🎵 Audio Only", "a|best|audio")]);

        // Hide DIRECT URL in message for later retrieval
        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `✅ *${info.title.substring(0, 50)}...*\nSource: [Link](${directUrl})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error("Handler Error:", err);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. The media might be deleted or private.");
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
            // If using direct link, format selector might need to be simple
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
        console.error("Download Error:", e);
        await ctx.editMessageText("❌ Download Failed.");
    } finally {
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
    }
});

// --- SERVER SETUP (Fixes Website Error) ---
app.get('/', (req, res) => res.send('✅ Bot is Alive!'));

if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${URL}/bot`);
    // CRITICAL: Listen on 0.0.0.0
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
} else {
    bot.launch();
}

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
