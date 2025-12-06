const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Import Version
const { version } = require('./package.json');

// Import Modules
const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
const downloader = require('./src/utils/downloader');

// Import Services
const redditService = require('./src/services/reddit');
const twitterService = require('./src/services/twitter');
const instagramService = require('./src/services/instagram');
const tiktokService = require('./src/services/tiktok'); // IMPORTED

// Init Logger
logger.init();

const bot = new Telegraf(config.BOT_TOKEN);
const app = express();

if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });

// --- UTILITIES ---
const resolveRedirect = async (url) => {
    // We allow TikTok short links (vm/vt) to pass through without expanding
    // because TikWM API handles them better than we can.
    if (!url.includes('/s/')) return url;
    try {
        const res = await axios.head(url, { maxRedirects: 0, validateStatus: s => s >= 300 && s < 400, headers: { 'User-Agent': config.UA_ANDROID } });
        return res.headers.location || url;
    } catch (e) { return url; }
};

// --- HANDLER ---
bot.start((ctx) => ctx.reply(`👋 **Media Banai Bot v${version}**\n\n✅ Reddit, Twitter\n✅ Instagram, TikTok\n\nSend a link!`));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(config.URL_REGEX);
    if (!match) return;

    console.log(`📩 New Request: ${match[0]}`);
    const msg = await ctx.reply("🔍 *Analyzing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const inputUrl = match[0];
        const fullUrl = await resolveRedirect(inputUrl);
        let media = null;

        // --- ROUTING ---
        if (fullUrl.includes('x.com') || fullUrl.includes('twitter.com')) {
            media = await twitterService.extract(fullUrl);
        } else if (fullUrl.includes('reddit.com') || fullUrl.includes('redd.it')) {
            media = await redditService.extract(fullUrl);
        } else if (fullUrl.includes('instagram.com')) {
            media = await instagramService.extract(fullUrl);
        } else if (fullUrl.includes('tiktok.com')) {
            media = await tiktokService.extract(fullUrl); // ROUTE TO TIKTOK
        }

        if (!media) throw new Error("Media not found");

        const buttons = [];
        let text = `✅ *${(media.title || 'Media Found').substring(0, 50)}...*`;

        if (media.type === 'gallery') {
            text += `\n📚 **Gallery:** ${media.items.length} items`;
            buttons.push([Markup.button.callback(`📥 Download Album`, `alb|all`)]);
        } 
        else if (media.type === 'image') {
            buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single`)]);
        } 
        else if (media.type === 'video') {
            // TikTok videos usually don't have multiple resolutions in the API
            // So we just show the default buttons
            if (media.formats && media.formats.length > 0) {
                const formats = media.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height).slice(0, 5);
                formats.forEach(f => {
                    if(!buttons.some(b => b[0].text.includes(f.height))) 
                        buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}`)]);
                });
            }
            if (buttons.length === 0) buttons.push([Markup.button.callback("📹 Download Video", `vid|best`)]);
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|best")]);
        }

        // IMPORTANT: For TikTok, we use the API URL (no watermark) as the source
        const targetUrl = (media.type === 'video' && media.url) ? media.url : (media.source || fullUrl);

        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `${text}\n[Source](${targetUrl})`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });

    } catch (e) {
        console.error(e);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Content unavailable.");
    }
});

// --- CALLBACKS ---
bot.on('callback_query', async (ctx) => {
    const [action, id] = ctx.callbackQuery.data.split('|');
    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    if (!url) return ctx.answerCbQuery("❌ Link expired.");

    if (action === 'img') {
        const sent = await ctx.replyWithPhoto(url);
        if(!sent) await ctx.replyWithDocument(url);
        await ctx.deleteMessage();
    } 
    else if (action === 'alb') {
        await ctx.answerCbQuery("🚀 Processing...");
        // Re-extract logic
        let media = null;
        if (url.includes('tiktok.com')) media = await tiktokService.extract(url);
        else if (url.includes('instagram.com')) media = await instagramService.extract(url);
        else if (url.includes('x.com')) media = await twitterService.extract(url);
        else media = await redditService.extract(url);

        if (media?.type === 'gallery') {
            await ctx.deleteMessage();
            for (const item of media.items) {
                try { if(item.type==='video') await ctx.replyWithVideo(item.url); else await ctx.replyWithDocument(item.url); } catch {}
            }
        }
    } 
    else {
        await ctx.answerCbQuery("🚀 Downloading...");
        await ctx.editMessageText(`⏳ *Downloading...*`, { parse_mode: 'Markdown' });
        
        const timestamp = Date.now();
        const basePath = path.join(config.DOWNLOAD_DIR, `${timestamp}`);
        const isAudio = action === 'aud';
        const finalFile = `${basePath}.${isAudio ? 'mp3' : 'mp4'}`;

        try {
            // For TikTok, the URL is usually the direct file already (thanks to API)
            // But downloader.download handles direct links perfectly fine too.
            await downloader.download(url, isAudio, id, basePath);

            const stats = fs.statSync(finalFile);
            if (stats.size > 49.5 * 1024 * 1024) {
                await ctx.editMessageText("⚠️ File > 50MB (Telegram Limit).");
            } else {
                await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
                if (isAudio) await ctx.replyWithAudio({ source: finalFile });
                else await ctx.replyWithVideo({ source: finalFile });
                await ctx.deleteMessage();
            }
        } catch (e) {
            console.error("Download Error:", e);
            await ctx.editMessageText("❌ Error during download.");
        } finally {
            if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
        }
    }
});

// --- SERVER ---
app.get('/api/logs', (req, res) => res.json(logger.getLogs()));
app.get('/', (req, res) => res.send(`<html><head><meta http-equiv="refresh" content="2"><title>Media Banai v${version}</title></head><body style="background:#0d1117;color:#c9d1d9;font-family:monospace;padding:20px"><h1>🚀 Media Banai Bot v${version}</h1><div id="logs">Loading...</div><script>fetch('/api/logs').then(r=>r.json()).then(d=>document.getElementById('logs').innerHTML=d.map(l=>\`<div>[\${l.time}] \${l.message}</div>\`).join(''))</script></body></html>`));

if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${config.APP_URL}/bot`);
    app.listen(config.PORT, '0.0.0.0', () => console.log(`🚀 Server on ${config.PORT}`));
} else { bot.launch(); }

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));