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

// --- INTELLIGENT MEDIA PARSER ---
// This function determines if it's a Video, Image, or Gallery
const fetchMediaDetails = async (postUrl) => {
    const cleanUrl = postUrl.split('?')[0];
    const jsonUrl = cleanUrl.replace(/\/$/, '') + '.json';

    try {
        console.log(`🕵️ Fetching: ${jsonUrl}`);
        const { data } = await axios.get(jsonUrl, {
            timeout: 5000,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const post = data[0].data.children[0].data;

        // CASE 1: REDDIT GALLERY (Multiple Images/Videos)
        if (post.is_gallery && post.media_metadata) {
            const items = [];
            const ids = post.gallery_data?.items || [];
            
            ids.forEach(item => {
                const meta = post.media_metadata[item.media_id];
                if (meta.status === 'valid') {
                    // Extract largest image 'u' stands for url, 's' is source
                    let mediaUrl = meta.s.u ? meta.s.u.replace(/&amp;/g, '&') : meta.s.gif;
                    // If it's a video in a gallery (rare but happens)
                    if (meta.e === 'Video') mediaUrl = meta.s.mp4 ? meta.s.mp4.replace(/&amp;/g, '&') : mediaUrl;
                    
                    items.push({ type: 'image', url: mediaUrl });
                }
            });

            return { type: 'gallery', title: post.title, items: items, source: postUrl };
        }

        // CASE 2: SINGLE VIDEO (Hosted on Reddit)
        if (post.secure_media && post.secure_media.reddit_video) {
            return {
                type: 'video',
                title: post.title,
                url: post.secure_media.reddit_video.hls_url || post.secure_media.reddit_video.fallback_url,
                source: postUrl
            };
        }

        // CASE 3: SINGLE IMAGE
        // If url ends in jpg/png/gif OR post_hint is image
        if (post.url && (post.url.match(/\.(jpeg|jpg|png|gif)$/i) || post.post_hint === 'image')) {
            return {
                type: 'image',
                title: post.title,
                url: post.url,
                source: postUrl
            };
        }

        return null;
    } catch (e) {
        console.error("API Parse Error:", e.message);
        return null; // Let yt-dlp try as fallback
    }
};

const runYtDlp = async (url) => {
    let cmd = `yt-dlp --force-ipv4 --no-warnings --no-playlist -J "${url}"`;
    if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;
    return await execPromise(cmd);
};

const downloadVideo = async (url, isAudio, outputPath) => {
    let cmd = `yt-dlp --force-ipv4 --no-warnings`;
    if (fs.existsSync(cookiePath)) cmd += ` --cookies "${cookiePath}"`;

    if (isAudio) {
        cmd += ` -x --audio-format mp3 -o "${outputPath}.%(ext)s" "${url}"`;
    } else {
        cmd += ` -f "best" --merge-output-format mp4 -o "${outputPath}.%(ext)s" "${url}"`;
    }
    return await execPromise(cmd);
};

// --- HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Ready! Send me any Reddit link (Video, Image, or Gallery)."));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(URL_REGEX);
    if (!match) return;

    const msg = await ctx.reply("🔍 *Analyzing Media Type...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const originalUrl = match[0];
        const fullUrl = await resolveRedirect(originalUrl);
        
        // 1. Determine Type using our Custom Parser
        let mediaData = await fetchMediaDetails(fullUrl);
        let info = {};

        // If Custom Parser failed, try yt-dlp (for Twitter/X or generic sites)
        if (!mediaData) {
            const { stdout } = await runYtDlp(fullUrl);
            info = JSON.parse(stdout);
            mediaData = { type: 'video', url: fullUrl, title: info.title }; // Assume video if yt-dlp works
        } else {
            info.title = mediaData.title;
        }

        const buttons = [];
        let displayText = `✅ *${(info.title || 'Media Found').substring(0, 50)}...*`;

        // 2. Build Buttons based on Type
        if (mediaData.type === 'gallery') {
            displayText += `\n\n📚 **Album Found:** ${mediaData.items.length} items`;
            // Button to trigger album download
            // We pass 'gallery' as type, and we don't pass ID, we will re-fetch in callback
            buttons.push([Markup.button.callback(`📥 Download Album (${mediaData.items.length})`, `alb|all|all`)]);
        } 
        else if (mediaData.type === 'image') {
            displayText += `\n\n🖼 **Single Image Detected**`;
            // Button for image
            buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single|single`)]);
        } 
        else {
            // It's a Video
            // If we have yt-dlp formats (e.g. Twitter), show resolutions
            if (info.formats && info.formats.length > 0) {
                const formats = info.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height);
                const seen = new Set();
                formats.slice(0, 5).forEach(f => {
                    if(!seen.has(f.height)) {
                        seen.add(f.height);
                        buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}|${f.height}`)]);
                    }
                });
            } else {
                buttons.push([Markup.button.callback("📹 Download Video", `vid|direct|best`)]);
            }
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|direct|audio")]);
        }

        // Store the FULL URL in the text link so we can access it in callback
        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `${displayText}\nSource: [Link](${fullUrl})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error("Handler Error:", err.message);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Content might be private or deleted.");
    }
});

bot.on('callback_query', async (ctx) => {
    const [action, id, label] = ctx.callbackQuery.data.split('|');
    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    
    if (!url) return ctx.answerCbQuery("❌ Link expired.");

    if (action === 'img') {
        // --- HANDLE SINGLE IMAGE ---
        await ctx.answerCbQuery("🚀 Sending Image...");
        // For images, we just send the URL directly. Telegram handles the download.
        // We re-fetch to get the direct link again to be safe
        const media = await fetchMediaDetails(url);
        if (media && media.type === 'image') {
            await ctx.replyWithPhoto(media.url, { caption: '🖼 Downloaded via Bot' });
        } else {
             await ctx.reply("❌ Could not retrieve image.");
        }
        await ctx.deleteMessage(); // Clean up menu
    } 
    else if (action === 'alb') {
        // --- HANDLE GALLERY/ALBUM ---
        await ctx.answerCbQuery("🚀 Processing Album...");
        await ctx.editMessageText(`⏳ *Fetching Album...*`, { parse_mode: 'Markdown' });
        
        const media = await fetchMediaDetails(url);
        
        if (media && media.type === 'gallery') {
             // Telegram MediaGroup can send up to 10 items at once
             // We'll split if > 10, or just send one by one for reliability
             const items = media.items;
             await ctx.editMessageText(`📤 *Sending ${items.length} items...*`, { parse_mode: 'Markdown' });

             for (const item of items) {
                 // Send each image. 
                 try {
                     await ctx.replyWithDocument(item.url); // Use Document to preserve quality
                 } catch (e) {
                     console.error("Failed to send album item:", e.message);
                 }
             }
             await ctx.deleteMessage();
        } else {
            await ctx.editMessageText("❌ Failed to load gallery.");
        }
    }
    else {
        // --- HANDLE VIDEO/AUDIO ---
        await ctx.answerCbQuery("🚀 Downloading...");
        await ctx.editMessageText(`⏳ *Downloading...*`, { parse_mode: 'Markdown' });

        const timestamp = Date.now();
        const basePath = path.join(downloadDir, `${timestamp}`);
        const finalFile = `${basePath}.${action === 'aud' ? 'mp3' : 'mp4'}`;

        try {
            if (id === 'direct') {
                // Direct extraction (Reddti)
                // Need to re-fetch the HLS link
                const media = await fetchMediaDetails(url);
                if (media && media.type === 'video') {
                     await downloadVideo(media.url, action === 'aud', basePath);
                } else {
                     throw new Error("Could not refresh direct video link");
                }
            } else {
                // yt-dlp extraction (Twitter)
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
app.get('/', (req, res) => res.send('✅ Bot Online v7'));
if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${APP_URL}/bot`);
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));
} else {
    bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
