const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Import Version from package.json
const { version } = require('./package.json');

// Import Modules
const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
const downloader = require('./src/utils/downloader');
const redditService = require('./src/services/reddit');
const twitterService = require('./src/services/twitter');

// Init Logger
logger.init();

const bot = new Telegraf(config.BOT_TOKEN);
const app = express();

if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });

// --- UTILITIES ---
const resolveRedirect = async (url) => {
    if (!url.includes('/s/')) return url;
    try {
        const res = await axios.head(url, { maxRedirects: 0, validateStatus: s => s >= 300 && s < 400, headers: { 'User-Agent': config.UA_ANDROID } });
        return res.headers.location || url;
    } catch (e) { return url; }
};

// --- HANDLER ---
bot.start((ctx) => ctx.reply(`👋 **Media Banai Bot v${version}**\n\nStable Release.\nSend Reddit or Twitter links.`));

bot.on('text', async (ctx) => {
    const match = ctx.message.text.match(config.URL_REGEX);
    if (!match) return;

    console.log(`📩 New Request: ${match[0]}`);
    const msg = await ctx.reply("🔍 *Analyzing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const inputUrl = match[0];
        const fullUrl = await resolveRedirect(inputUrl);
        let media = null;

        if (fullUrl.includes('x.com') || fullUrl.includes('twitter.com')) {
            media = await twitterService.extract(fullUrl);
        } else {
            media = await redditService.extract(fullUrl);
        }

        if (!media) throw new Error("Media not found");

        const buttons = [];
        let text = `✅ *${(media.title).substring(0, 50)}...*`;

        if (media.type === 'gallery') {
            text += `\n📚 **Gallery:** ${media.items.length} items`;
            buttons.push([Markup.button.callback(`📥 Download Album`, `alb|all`)]);
        } 
        else if (media.type === 'image') {
            buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single`)]);
        } 
        else if (media.type === 'video') {
            if (media.formats?.length > 0) {
                media.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height).slice(0, 5).forEach(f => {
                    if(!buttons.some(b => b[0].text.includes(f.height))) 
                        buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}`)]);
                });
            } else {
                buttons.push([Markup.button.callback("📹 Download Video", `vid|best`)]);
            }
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|best")]);
        }

        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `${text}\n[Source](${media.url || media.source})`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });

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

    if (action === 'img') {
        const sent = await ctx.replyWithPhoto(url);
        if(!sent) await ctx.replyWithDocument(url);
        await ctx.deleteMessage();
    } 
    else if (action === 'alb') {
        await ctx.answerCbQuery("🚀 Processing...");
        let media = null;
        if (url.includes('x.com') || url.includes('twitter')) media = await twitterService.extract(url);
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
            console.log(`⬇️ Downloading: ${url}`);
            await downloader.download(url, isAudio, id, basePath);
            const stats = fs.statSync(finalFile);
            
            if (stats.size > 49.5 * 1024 * 1024) await ctx.editMessageText("⚠️ File > 50MB");
            else {
                await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
                if (isAudio) await ctx.replyWithAudio({ source: finalFile });
                else await ctx.replyWithVideo({ source: finalFile });
                await ctx.deleteMessage();
                console.log(`✅ Uploaded: ${url}`);
            }
        } catch (e) { console.error(e); await ctx.editMessageText("❌ Error"); } 
        finally { if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile); }
    }
});

// --- LIVE TAIL PAGE ---
app.get('/api/logs', (req, res) => res.json(logger.getLogs()));
// Server now displays the version
app.get('/', (req, res) => res.send(`<html><head><meta http-equiv="refresh" content="2"><title>Media Banai v${version}</title></head><body style="background:#0d1117;color:#c9d1d9;font-family:monospace;padding:20px"><h1>🚀 Media Banai Bot v${version}</h1><div id="logs">Loading...</div><script>fetch('/api/logs').then(r=>r.json()).then(d=>document.getElementById('logs').innerHTML=d.map(l=>\`<div style="border-bottom:1px solid #30363d;padding:2px"><span style="color:#8b949e">[\${l.time}]</span> <span style="color:\${l.type==='ERROR'?'#f85149':'#3fb950'}">\${l.type}</span> \${l.message}</div>\`).join(''))</script></body></html>`));

if (process.env.NODE_ENV === 'production') {
    app.use(bot.webhookCallback('/bot'));
    bot.telegram.setWebhook(`${config.APP_URL}/bot`);
    app.listen(config.PORT, '0.0.0.0', () => console.log(`🚀 Server on ${config.PORT}`));
} else { bot.launch(); }

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
