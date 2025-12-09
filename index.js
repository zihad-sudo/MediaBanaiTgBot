const { Telegraf } = require('telegraf');
const fs = require('fs');
const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
const db = require('./src/utils/db');

// Services
const poller = require('./src/services/poller'); 

// Handlers
const { 
    handleMessage, 
    handleCallback, 
    handleGroupMessage, 
    handleStart, 
    handleHelp, 
    handleConfig,
    handleEditCaption // ✅ Import new handler
} = require('./src/utils/handlers');

const { handleStats, handleBroadcast } = require('./src/utils/admin'); 
const { setupServer } = require('./src/server/web');

// 1. Initialize
logger.init();
if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });
db.connect(); 

const bot = new Telegraf(config.BOT_TOKEN);

// --- COMMANDS ---
bot.start(handleStart);
bot.help(handleHelp);
bot.command('stats', handleStats);
bot.command('broadcast', handleBroadcast);
bot.command('setup_api', handleConfig);
bot.command('mode', handleConfig);
bot.command('set_destination', handleConfig);

// --- MESSAGE LOGIC ---
bot.on('text', async (ctx, next) => {
    // 1. Check if user is trying to edit caption
    if (await handleEditCaption(ctx)) return;

    // 2. Check Ghost Mentions (Groups)
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await handleGroupMessage(ctx, () => handleMessage(ctx));
    } else {
        // 3. Private Chat -> Download
        handleMessage(ctx);
    }
});

// --- CALLBACKS ---
bot.on('callback_query', handleCallback);

// --- START SERVICES ---
poller.init(bot);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

setupServer(bot);
