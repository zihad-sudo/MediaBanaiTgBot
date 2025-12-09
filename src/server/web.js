const express = require('express');
const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/settings');
const handlers = require('../utils/handlers'); 

const setupServer = (bot) => {
    const app = express();

    // 1. Logs
    app.get('/api/logs', (req, res) => res.json(logger.getLogs()));

    // 2. SECRET WEBHOOK (Fixed with Link Extraction)
    app.get('/api/trigger', async (req, res) => {
        const { secret, url } = req.query;

        // Security Check
        if (secret !== String(config.ADMIN_ID)) {
            return res.status(403).send('❌ Access Denied');
        }
        if (!url) return res.status(400).send('❌ No URL provided');

        // ✅ FIX: Extract the actual link from the text
        // If user shares "Check this https://x.com/...", we grab only the URL
        const match = url.match(config.URL_REGEX);
        const cleanUrl = match ? match[0] : url; // Fallback to original if no regex match

        // Respond to phone immediately
        res.send(`✅ Processing: ${cleanUrl}`);

        try {
            const userId = config.ADMIN_ID;
            
            // 1. Send "Thinking" message
            const msg = await bot.telegram.sendMessage(userId, `🔄 <b>Auto-Download...</b>\n🔗 ${cleanUrl}`, { parse_mode: 'HTML' });

            // 2. Mock Context
            const fakeCtx = {
                chat: { id: userId },
                telegram: bot.telegram,
                replyWithAudio: (doc, opts) => bot.telegram.sendAudio(userId, doc.source, opts),
                replyWithVideo: (doc, opts) => bot.telegram.sendVideo(userId, doc.source, opts),
                telegram: {
                    editMessageText: (chatId, msgId, inlineMsgId, text, extra) => 
                        bot.telegram.editMessageText(chatId, msgId, inlineMsgId, text, extra),
                    deleteMessage: (chatId, msgId) => bot.telegram.deleteMessage(chatId, msgId)
                }
            };

            // 3. Download using the CLEAN URL
            await handlers.performDownload(fakeCtx, cleanUrl, false, 'best', msg.message_id, `🤖 <b>Auto-Captured</b>\nSource: ${cleanUrl}`, null);

        } catch (e) {
            console.error("Webhook Error:", e);
        }
    });

    // 3. Hacker Terminal
    app.get('/', (req, res) => {
        res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Media Banai</title><style>body{background:#0d1117;color:#c9d1d9;font-family:monospace;padding:20px}h1{color:#58a6ff;border-bottom:1px solid #30363d;padding-bottom:10px}.log-entry{border-bottom:1px solid #161b22;padding:4px 0}.INFO{color:#3fb950}.ERROR{color:#f85149}</style></head><body><h1>🚀 Media Banai Bot</h1><div id="logs">Connecting...</div><script>setInterval(async()=>{try{const r=await fetch('/api/logs');const d=await r.json();document.getElementById('logs').innerHTML=d.map(l=>\`<div class="log-entry"><span class="\${l.type}">[\${l.time}] \${l.type}:</span> \${l.message}</div>\`).join('');}catch(e){}},2000);</script></body></html>`);
    });

    // Anti-Sleep
    const keepAlive = () => {
        if (config.APP_URL) axios.get(`${config.APP_URL}/api/logs`).then(()=>console.log("⏰ Ping")).catch(()=>{});
    };
    setInterval(keepAlive, 600000);

    if (process.env.NODE_ENV === 'production') {
        app.use(bot.webhookCallback('/bot'));
        bot.telegram.setWebhook(`${config.APP_URL}/bot`);
        app.listen(config.PORT, '0.0.0.0', () => console.log(`🚀 Server listening on port ${config.PORT}`));
        setTimeout(keepAlive, 60000); 
    } else {
        bot.launch();
        console.log("🚀 Polling mode started");
    }
};

module.exports = { setupServer };
