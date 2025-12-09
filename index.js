const { Telegraf } = require('telegraf');
const fs = require('fs');
const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
const db = require('./src/utils/db');

// Imports
const { handleMessage, handleCallback, handleGroupMessage, handleStart, handleHelp } = require('./src/utils/handlers');
const { handleStats, handleBroadcast } = require('./src/utils/admin'); // NEW FILE
const { setupServer } = require('./src/server/web');

logger.init();
if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });

// Connect DB
db.connect(); 

const bot = new Telegraf(config.BOT_TOKEN);

// --- COMMANDS ---
bot.start(handleStart);
bot.help(handleHelp);

// Admin Commands (Now in separate file)
bot.command('stats', handleStats);
bot.command('broadcast', handleBroadcast);

// Group & Text Logic
bot.on('text', async (ctx, next) => {
    // Check for Ghost Mentions first
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await handleGroupMessage(ctx, () => handleMessage(ctx));
    } else {
        handleMessage(ctx);
    }
});

bot.on('callback_query', handleCallback);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

setupServer(bot);