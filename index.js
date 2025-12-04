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

// Regex for Reddit/Twitter
const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- UTILITIES ---

// 1. Resolve /s/ links to full links
const resolveRedirect = async (url) => {
    if (!url.includes('/s/')) return url;
    try {
        const res = await axios.head(url, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 300 && status < 400,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36'
            }
        });
        return res.headers.location || url;
    } catch (e) {
        return url;
    }
};

// 2. The "Smart" Downloader
const runYtDlp = async (targetUrl) => {
    // Standard User-Agent to look like a Firefox browser
    const cmd = `yt-dlp --force-ipv4 --no-warnings --no-playlist --add-header "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0" -J "${targetUrl}"`;
    return await execPromise(cmd);
};

// 3. Fallback: Get Direct Video Link via JSON API (Bypasses Main Site Block)
const getRedditApiMetadata = async (webUrl) => {
    try {
        // Remove query params and append .json
        const jsonUrl = webUrl.split('?')[0] + '.json';
        console.log("⚠️ 403 Blocked. Trying API fallback:", jsonUrl);
        
        const { data } = await axios.get(jsonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36' }
        });

        const post = data[0].data.children[0].data;
        
        // Check for video
        if (post.secure_media && post.secure_media.reddit_video) {
            return {
                title: post.title,
                // The DASH url is on v.redd.it which is NOT blocked!
                url: post.secure_media.reddit_video.dash_url || post.secure_media.reddit_video.fallback_url,
                is_video: true
            };
        } else if (post.url && post.url.includes('i.redd.it')) {
            return { title: post.title, url: post.url, is_video: false };
        }
        return null;
    } catch (e) {
        console.error("API Fallback failed:", e.message);
        return null;
    }
};

// --- BOT HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Bot Online. Send a link!"));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(URL_REGEX);
    if (!match) return;

    const msg = await ctx.reply("🔍 *Processing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        // Step A: Resolve Redirects
        let url = await resolveRedirect(match[0]);
        let info;
        let directUrl = url; // Default to web url

        // Step B: Try standard yt-dlp metadata fetch
        try {
            const { stdout } = await runYtDlp(url);
            info = JSON.parse(stdout);
        } catch (err) {
            // Step C: CATCH BLOCK - If Reddit blocks us (403), use API Fallback
            if (err.stderr && err.stderr.includes('403')) {
                const apiData = await getRedditApiMetadata(url);
                if (!apiData) throw new Error("Could not fetch media via API.");
                
                // If we found a direct video link (v.redd.it), use that!
                // yt-dlp works fine on v.redd.it links even if reddit.com is blocked
                info = {
                    title: apiData.title,
                    formats: [], // We will just force download
                    extractor_key: 'RedditAPI'
                };
                directUrl = apiData.url; // Use the DASH/HLS url
            } else {
                throw err; // Real error
            }
        }

        // Build Buttons
        // If we used fallback, we might not have quality list, so specific buttons
        const buttons = [];
        if (info.formats && info.formats.length > 0) {
            // Logic for standard success
            const formats = info.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height);
            const seen = new Set();
            formats.slice(0, 5).forEach(f => {
                if(!seen.has(f.height)) {
                    seen.add(f.height);
                    buttons.push([Markup.button.callback(`📹 ${f.height}p`, `v|${f.format_id}|${f.height}`)]);
                }
            });
        } else {
            // Fallback buttons (We download 'best' available from the direct link)
            buttons.push([Markup.button.callback("📹 Download Best Quality", `v|best|best`)]);
        }
        buttons.push([Markup.button.callback("🎵 Audio Only", "a|best|audio")]);

        // Hide the DIRECT URL in the message
        // If it's the fallback URL (v.redd.it), this fixes the download step too!
        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `✅ *${info.title.substring(0, 50)}...*\nSource: [Link](${directUrl})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error("Processing Error:", err);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Reddit is refusing connection.");
    }
});

bot.on('callback_query', async (ctx) => {
    const [type, id, label] = ctx.callbackQuery.data.split('|');
    
    // Retrieve the URL (might be the v.redd.it link from fallback)
    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    if (!url) return ctx.answerCbQuery("❌ Error: Link lost.");

    await ctx.answerCbQuery("🚀 Downloading...");
    await ctx.editMessageText(`⏳ *Downloading...*`, { parse_mode: 'Markdown' });

    const timestamp = Date.now();
    const basePath = path.join(downloadDir, `${timestamp}`);
    const finalFile = `${basePath}.${type === 'a' ? 'mp3' : 'mp4'}`;

    try {
        // If we are using a direct v.redd.it link (fallback), 'best' works.
        // If normal link, 'id' works.
        let cmd;
        if (type === 'a') {
            cmd = `yt-dlp --force-ipv4 --no-warnings -x --audio-format mp3 -o "${basePath}.%(ext)s" "${url}"`;
        } else {
            // Use 'best' if id is generic, otherwise specific format
            const formatSelector = id === 'best' ? 'bestvideo+bestaudio/best' : `${id}+bestaudio/best`;
            cmd = `yt-dlp --force-ipv4 --no-warnings -f "${formatSelector}" --merge-output-format mp4 -o "${basePath}.%(ext)s" "${url}"`;
        }

        await execPromise(cmd);

        // Upload
        const stats = fs.statSync(finalFile);
        if (stats.size > 49.5 * 1024 * 1024) {
            await ctx.editMessageText("⚠️ File > 50MB. Telegram limit exceeded.");
        } else {
            await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
            if (type === 'a') {
                await ctx.replyWithAudio({ source: finalFile }, { caption: '🎵 Audio' });
            } else {
                await ctx.replyWithVideo({ source: finalFile }, { caption: `🎥 Video` });
            }
            await ctx.deleteMessage();
        }
    } catch (e) {
        console.error("Download Error:", e);
        await ctx.editMessageText("❌ Download Failed.");
    } finally {
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
    }
});

// --- SERVER SETUP (Fixes Browser 403) ---
app.get('/', (req, res) => res.send('✅ Bot is Alive!'));

if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${URL}/bot`);
    // Listen on 0.0.0.0 to ensure external access
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
} else {
    bot.launch();
}
