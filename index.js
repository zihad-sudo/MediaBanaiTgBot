const { Telegraf } = require('telegraf');
const fs = require('fs');
const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
const db = require('./src/utils/db');

// Imports
const { 
    handleMessage, 
    handleCallback, 
    handleGroupMessage, 
    handleStart, 
    handleHelp,
			handleConfig
} = require('./src/utils/handlers');

const { handleStats, handleBroadcast } = require('./src/utils/admin'); 
const { setupServer } = require('./src/server/web');

// 1. Initialize Logger & Folders
logger.init();
if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });

// 2. Connect Database
db.connect(); 

// 3. Initialize Bot
const bot = new Telegraf(config.BOT_TOKEN);

// --- COMMANDS ---
bot.start(handleStart);
bot.help(handleHelp);
bot.command('set_destination', handleConfig);

// Admin Commands
bot.command('stats', handleStats);
bot.command('broadcast', handleBroadcast);

// --- MESSAGE LOGIC ---
bot.on('text', async (ctx, next) => {
    // 1. If Group: Check for Ghost Mentions first
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await handleGroupMessage(ctx, () => handleMessage(ctx));
    } else {
        // 2. If Private: Go straight to Download Logic
        handleMessage(ctx);
    }
});

// --- CALLBACKS (Buttons) ---
bot.on('callback_query', handleCallback);

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Start Web Server (The Webhook Listener)
setupServer(bot);
