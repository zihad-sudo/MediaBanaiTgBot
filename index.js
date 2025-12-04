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
    // Fix: Un-escape newlines that Render might have broken
    rawData = rawData.replace(/\\n/g, '\n');
    if (!rawData.startsWith('# Netscape')) rawData = "# Netscape HTTP Cookie File\n" + rawData;
    fs.writeFileSync(cookiePath, rawData);
    console.log("✅ Cookies loaded!");
}

// --- 2. MIRRORS (The Backup Plan) ---
const MIRRORS = [
    'https://redlib.catsarch.com',
    'https://redlib.vlingit.com',
    'https://redlib.tux.pizza',
    'https://libreddit.kavin.rocks'
];

const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- UTILITIES ---

// CRITICAL FIX: Expand /s/ links so Mirrors can read them
const resolveRedirect = async (shortUrl) => {
    if (!shortUrl.includes('/s/')) return shortUrl;
    try {
        console.log("🔄 Resolving short link...");
        const res = await axios.head(shortUrl, {
            maxRedirects: 0,
            validateStatus: (s) => s >= 300 && s < 400,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        });
        return res.headers.location || shortUrl;
    } catch (e) {
        console.log("⚠️ Resolve failed, using original.");
        return shortUrl;
    }
};

const runYtDlp = async (url) => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    let cmd = `yt-dlp --force-ipv4 --no-warnings --no-playlist --user-agent "${ua}" -J "${url}"`;
    if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;
    return await execPromise(cmd);
};

const getMirrorLink = async (fullUrl) => {
    try {
        const parsed = new URL(fullUrl);
        // Ensure we remove any query params like ?share_id=...
        const cleanPath = parsed.pathname; 
        
        for (const domain of MIRRORS) {
            try {
                // Append .json to the CLEAN path
                const apiUrl = `${domain}${cleanPath}.json`;
                console.log(`🛡️ Checking Mirror: ${apiUrl}`);

                const { data } = await axios.get(apiUrl, { timeout: 4000 });
                const post = data[0].data.children[0].data;
                
                if (post.is_video && post.media?.reddit_video) {
                    return { 
                        title: post.title, 
                        url: post.media.reddit_video.fallback_url.split('?')[0],
                        is_video: true 
                    };
                }
            } catch (e) { continue; }
        }
    } catch (e) { console.error("Mirror Error:", e.message); }
    return null;
};

const downloadMedia = async (url, isAudio, formatId, outputPath) => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    let cmd = `yt-dlp --force-ipv4 --no-warnings --user-agent "${ua}"`;
    if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;

    if (isAudio) {
        cmd += ` -x --audio-format mp3 -o "${outputPath}.%(ext)s" "${url}"`;
    } else {
        const fmt = formatId === 'best' ? 'best' : `${formatId}+bestaudio/best`;
        cmd += ` -f "${fmt}" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`;
    }
    return await execPromise(cmd);
};

// --- HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Ready! Send me a link."));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(URL_REGEX);
    if (!match) return;

    const msg = await ctx.reply("🔍 *Processing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        // STEP 1: RESOLVE SHORT LINK (Crucial Fix)
        const originalUrl = match[0];
        let fullUrl = await resolveRedirect(originalUrl);
        
        // Remove tracking params (?share_id=...)
        try {
            const u = new URL(fullUrl);
            u.search = "";
            fullUrl = u.toString();
        } catch(e) {}

        console.log(`🎯 Target: ${fullUrl}`);

        let info = {};
        let downloadUrl = fullUrl;

        // STEP 2: TRY MAIN SITE (COOKIES)
        try {
            const { stdout } = await runYtDlp(fullUrl);
            info = JSON.parse(stdout);
            console.log("✅ Fetched via Main Site");
        } catch (err) {
            console.log("⚠️ Main site failed. Activating Mirror...");
            
            // STEP 3: TRY MIRROR (BACKUP)
            if (fullUrl.includes('reddit.com')) {
                const mirrorData = await getMirrorLink(fullUrl);
                if (mirrorData) {
                    console.log("✅ Fetched via Mirror!");
                    info = { title: mirrorData.title, formats: [], extractor_key: 'Mirror' };
                    downloadUrl = mirrorData.url; // Use direct v.redd.it link
                } else {
                    throw err; // Mirror failed too
                }
            } else {
                throw err;
            }
        }

        // STEP 4: BUTTONS
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
        }
        if (buttons.length === 0) buttons.push([Markup.button.callback("📹 Download Video", `v|best|best`)]);
        buttons.push([Markup.button.callback("🎵 Audio Only", "a|best|audio")]);

        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `✅ *${(info.title || 'Media Found').substring(0, 50)}...*\nSource: [Link](${downloadUrl})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error("Final Error:", err.message);
        let text = "❌ Failed. Mirrors are busy.";
        if (err.message.includes('403')) text = "❌ Blocked. Cookies invalid & Mirrors failed.";
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, text);
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
        await downloadMedia(url, type === 'a', id, basePath);
        
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
