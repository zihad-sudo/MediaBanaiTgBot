const { Telegraf } = require('telegraf');
const fs = require('fs');

const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
const db = require('./src/utils/db'); // IMPORT DB
const messageHandler = require('./src/controllers/messageHandler');
const callbackHandler = require('./src/controllers/callbackHandler');
const webServer = require('./src/server/web');
const { version } = require('./package.json');

logger.init();
const bot = new Telegraf(config.BOT_TOKEN);

if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });

// --- MIDDLEWARE: TRACK USERS ---
bot.use(async (ctx, next) => {
    if (ctx.from) db.addUser(ctx.from.id);
    await next();
});

bot.command('stats', (ctx) => {
    const s = db.getStats();
    ctx.reply(`📊 **Bot Stats**\n\n👥 Users: ${db.getUserCount()}\n⬇️ Downloads: ${s.downloads}\n⚡ Cache Hits: ${s.cacheHits}`);
});

bot.start((ctx) => ctx.reply(`👋 **Media Banai Bot v${version}**\n\n✅ Reddit, Twitter\n✅ Instagram, TikTok\n\nSend a link!`));

bot.on('text', messageHandler.handleMessage);
bot.on('callback_query', callbackHandler.handleCallback);

webServer.start(bot);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));