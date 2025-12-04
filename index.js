/**
 * UNIVERSAL MEDIA DOWNLOADER BOT
 * Fixed: Renamed URL variable to avoid conflict with Node.js URL constructor
 */

require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN; 
// RENAMED VARIABLE TO AVOID CONFLICT
const APP_URL = process.env.RENDER_EXTERNAL_URL; 
const PORT = process.env.PORT || 3000;

// Reliable Cobalt Instances
const COBALT_INSTANCES = [
    'https://api.cobalt.tools/api/json',
    'https://cobalt.kwiatekmiki.pl/api/json',
    'https://co.wuk.sh/api/json'
];

if (!BOT_TOKEN) {
    console.error('❌ ERROR: BOT_TOKEN is missing. Check your .env or Render configs.');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// --- DOWNLOAD HELPER ---
async function fetchMedia(targetUrl) {
    let lastError = null;
    for (const apiBase of COBALT_INSTANCES) {
        try {
            console.log(`Trying instance: ${apiBase}`);
            const response = await axios.post(apiBase, {
                url: targetUrl,
                vCodec: 'h264',
                vQuality: '720',
                isAudioOnly: false,
                dubLang: false,
                disableMetadata: true 
            }, {
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                timeout: 15000 
            });

            if (response.data && (response.data.url || response.data.picker)) {
                return response.data;
            }
        } catch (error) {
            console.error(`Instance ${apiBase} failed.`);
            lastError = error;
        }
    }
    throw lastError || new Error('All instances failed');
}

// --- BOT LOGIC ---
bot.start((ctx) => ctx.reply('👋 Send me a link (YouTube, Insta, TikTok, X, etc.)!'));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
    if (!urlMatch) return; 

    const targetUrl = urlMatch[0];
    const statusMsg = await ctx.reply('🔍 *Processing...*', { parse_mode: 'Markdown' });

    try {
        const data = await fetchMedia(targetUrl);

        // 1. Handle Albums/Pickers
        if (data.status === 'picker' && data.picker) {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '📦 *Album detected!* Sending files...', { parse_mode: 'Markdown' });
            for (const item of data.picker) {
                await ctx.replyWithDocument(item.url).catch(() => {});
            }
            return;
        }

        // 2. Handle Single File
        if (data.url) {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '⬇️ *Downloading...*', { parse_mode: 'Markdown' });
            // Try sending as video, fallback to document
            try {
                await ctx.replyWithVideo(data.url, { caption: 'Downloaded via @' + ctx.botInfo.username });
            } catch (e) {
                await ctx.replyWithDocument(data.url, { caption: 'Downloaded via @' + ctx.botInfo.username });
            }
            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        } else {
            throw new Error('No media URL found.');
        }

    } catch (err) {
        console.error('Download failed:', err.message);
        let msg = '❌ *Download Failed.*\n\n';
        
        if (targetUrl.includes('reddit.com') && err.message) {
            msg += '⚠️ *Note:* Age-restricted (NSFW) Reddit posts usually fail on public bots.';
        } else {
            msg += 'Link might be private, broken, or geo-restricted.';
        }
        
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, msg, { parse_mode: 'Markdown' });
    }
});

// --- SERVER STARTUP (FIXED) ---
async function startApp() {
    if (APP_URL) {
        // Use APP_URL here instead of URL
        await bot.createWebhook({ domain: APP_URL });
        
        // Use global URL constructor safely now
        app.use(bot.webhookCallback(new URL(APP_URL).pathname)); 
        console.log(`Webhook attached to: ${APP_URL}`);
    } else {
        console.log('No RENDER_EXTERNAL_URL found, running in polling mode for local dev...');
        bot.launch();
    }

    app.get('/', (req, res) => res.send('Bot is Alive!'));
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

startApp();

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
