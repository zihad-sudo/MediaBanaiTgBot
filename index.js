const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { version } = require('./package.json');
const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
const downloader = require('./src/utils/downloader');

// Services
const redditService = require('./src/services/reddit');
const twitterService = require('./src/services/twitter');
const instagramService = require('./src/services/instagram');
const tiktokService = require('./src/services/tiktok');
const musicService = require('./src/services/music'); // If you have it

logger.init();
const bot = new Telegraf(config.BOT_TOKEN);
const app = express();

if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });

// --- HANDLERS ---
const resolveRedirect = async (url) => {
    if (!url.includes('/s/') && !url.includes('vm.tiktok') && !url.includes('vt.tiktok')) return url;
    try {
        const res = await axios.head(url, { maxRedirects: 0, validateStatus: s => s >= 300 && s < 400, headers: { 'User-Agent': config.UA_ANDROID } });
        return res.headers.location || url;
    } catch (e) { return url; }
};

bot.start((ctx) => ctx.reply(`👋 **Media Banai v${version}**\n\n✅ Reddit, Twitter\n✅ Instagram, TikTok\n\nSend a link!`));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(config.URL_REGEX);
    if (!match) return;

    console.log(`📩 Request: ${match[0]}`);
    const msg = await ctx.reply("🔍 *Analyzing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const fullUrl = await resolveRedirect(match[0]);
        let media = null;

        // Routing
        if (fullUrl.includes('x.com') || fullUrl.includes('twitter.com')) media = await twitterService.extract(fullUrl);
        else if (fullUrl.includes('reddit.com') || fullUrl.includes('redd.it')) media = await redditService.extract(fullUrl);
        else if (fullUrl.includes('instagram.com')) media = await instagramService.extract(fullUrl);
        else if (fullUrl.includes('tiktok.com')) media = await tiktokService.extract(fullUrl);
        else if (fullUrl.includes('spotify') || fullUrl.includes('soundcloud')) media = await musicService.extract(fullUrl);

        if (!media) throw new Error("Not found");

        // Buttons
        const buttons = [];
        let text = `✅ *${(media.title).substring(0, 50)}...*`;

        if (media.type === 'gallery') {
            text += `\n📚 **Album:** ${media.items.length} items`;
            buttons.push([Markup.button.callback(`📥 Download Album`, `alb|all`)]);
        } 
        else if (media.type === 'image') {
            buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single`)]);
        } 
        else if (media.type === 'video') {
            if (media.formats?.length > 0 && !fullUrl.includes('tiktok') && !fullUrl.includes('instagram')) {
                // Show qualities for Reddit/Twitter
                const formats = media.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height).slice(0, 5);
                formats.forEach(f => {
                    if(!buttons.some(b => b[0].text.includes(f.height))) 
                        buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}`)]);
                });
            }
            if (buttons.length === 0) buttons.push([Markup.button.callback("📹 Download Video", `vid|best`)]);
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|best")]);
        }

        const safeUrl = (media.type === 'video' && media.url) ? media.url : (media.source || fullUrl);
        
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `${text}\n[Source](${safeUrl})`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });

    } catch (e) {
        console.error(e);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Content unavailable.");
    }
});

// --- CALLBACKS ---
bot.on('callback_query', async (ctx) => {
    const [action, id] = ctx.callbackQuery.data.split('|');
    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    if (!url) return ctx.answerCbQuery("❌ Expired");

    // --- IMAGE DOWNLOADER (Fix for Instagram) ---
    if (action === 'img') {
        await ctx.answerCbQuery("🚀 Downloading...");
        const timestamp = Date.now();
        const imgPath = path.join(config.DOWNLOAD_DIR, `${timestamp}.jpg`);
        
        try {
            // Download Locally First!
            await downloader.downloadFile(url, imgPath);
            await ctx.replyWithPhoto({ source: imgPath });
            await ctx.deleteMessage();
        } catch (e) {
            console.error("Image send failed:", e);
            // Fallback to URL method
            try { await ctx.replyWithPhoto(url); } catch { await ctx.replyWithDocument(url); }
        } finally {
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        }
    } 
    // --- ALBUM DOWNLOADER ---
    else if (action === 'alb') {
        await ctx.answerCbQuery("🚀 Processing...");
        await ctx.editMessageText("⏳ *Fetching Album...*", { parse_mode: 'Markdown' });
        
        // Re-Extract to get items list
        let media = null;
        if (url.includes('tiktok.com')) media = await tiktokService.extract(url);
        else if (url.includes('instagram.com')) media = await instagramService.extract(url);
        else if (url.includes('reddit.com')) media = await redditService.extract(url);
        else if (url.includes('x.com')) media = await twitterService.extract(url);

        if (media?.type === 'gallery') {
            await ctx.editMessageText(`📤 *Sending ${media.items.length} items...*`, { parse_mode: 'Markdown' });
            
            for (const item of media.items) {
                try {
                    if (item.type === 'video') {
                        // Send Video URL directly (usually works)
                        await ctx.replyWithVideo(item.url);
                    } else {
                        // Download Image locally (Fix for Insta)
                        const tmpName = path.join(config.DOWNLOAD_DIR, `gal_${Date.now()}_${Math.random()}.jpg`);
                        await downloader.downloadFile(item.url, tmpName);
                        await ctx.replyWithDocument({ source: tmpName }); // Doc for full quality
                        fs.unlinkSync(tmpName);
                    }
                } catch (e) { console.error("Gallery item failed"); }
            }
            await ctx.deleteMessage();
        } else {
            await ctx.editMessageText("❌ Failed to load gallery.");
        }
    } 
    // --- VIDEO DOWNLOADER ---
    else {
        await ctx.answerCbQuery("🚀 Downloading...");
        await ctx.editMessageText(`⏳ *Downloading...*`, { parse_mode: 'Markdown' });
        
        const timestamp = Date.now();
        const basePath = path.join(config.DOWNLOAD_DIR, `${timestamp}`);
        const isAudio = action === 'aud';
        const finalFile = `${basePath}.${isAudio ? 'mp3' : 'mp4'}`;

        try {
            // Check if URL is direct file (TikTok/Insta) or needs yt-dlp extraction
            if (id === 'best' && (url.includes('.mp4') || url.includes('.mp3'))) {
                // It's a direct link, just download it file-style
                await downloader.downloadFile(url, finalFile);
            } else {
                // Use yt-dlp
                await downloader.download(url, isAudio, id, basePath);
            }

            const stats = fs.statSync(finalFile);
            if (stats.size > 49.5 * 1024 * 1024) await ctx.editMessageText("⚠️ File > 50MB");
            else {
                await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
                if (isAudio) await ctx.replyWithAudio({ source: finalFile });
                else await ctx.replyWithVideo({ source: finalFile });
                await ctx.deleteMessage();
            }
        } catch (e) {
            console.error("DL Error:", e);
            await ctx.editMessageText("❌ Error.");
        } finally {
            if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
        }
    }
});

// --- SERVER ---
app.get('/api/logs', (req, res) => res.json(logger.getLogs()));
app.get('/', (req, res) => res.send(`<html><head><meta http-equiv="refresh" content="2"></head><body style="background:black;color:#0f0;font-family:monospace"><h1>🚀 Media Banai Live</h1><div id="logs">Loading...</div><script>fetch('/api/logs').then(r=>r.json()).then(d=>document.getElementById('logs').innerHTML=d.map(l=>\`<div>[\${l.time}] \${l.message}</div>\`).join(''))</script></body></html>`));

if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${config.APP_URL}/bot`);
    app.listen(config.PORT, '0.0.0.0', () => console.log(`🚀 Server on ${config.PORT}`));
} else { bot.launch(); }

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));