const { Telegraf } = require('telegraf');
const fs = require('fs');

// 1. Config & Logger
const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
logger.init();

// 2. Import Controllers
const messageHandler = require('./src/controllers/messageHandler');
const callbackHandler = require('./src/controllers/callbackHandler');
const webServer = require('./src/server/web');
const { version } = require('./package.json');

// 3. Init Bot
const bot = new Telegraf(config.BOT_TOKEN);

// Ensure Directories
if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });

// 4. Register Handlers
bot.start((ctx) => ctx.reply(`👋 **Media Banai Bot v${version}**\n\n✅ Reddit, Twitter\n✅ Instagram, TikTok\n\nSend a link!`));

bot.on('text', messageHandler.handleMessage);
bot.on('callback_query', callbackHandler.handleCallback);

// 5. Start Server
webServer.start(bot);

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));