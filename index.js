const { Telegraf } = require('telegraf');
const fs = require('fs');
const config = require('./src/config/settings');
const logger = require('./src/utils/logger');
const db = require('./src/utils/db');

// Services
const poller = require('./src/services/poller'); 
const redditRss = require('./src/services/reddit_rss'); // ✅ Import

// Handlers
const { 
    handleMessage, handleCallback, handleGroupMessage, handleStart, handleHelp, handleConfig, handleEditCaption 
} = require('./src/utils/handlers');

const { handleStats, handleBroadcast } = require('./src/utils/admin'); 
const { setupServer } = require('./src/server/web');

// Init
logger.init();
if (!fs.existsSync(config.DOWNLOAD_DIR)) fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });
db.connect(); 

const bot = new Telegraf(config.BOT_TOKEN);

// Commands
bot.start(handleStart);
bot.help(handleHelp);
bot.command('stats', handleStats);
bot.command('broadcast', handleBroadcast);
bot.command('setup_api', handleConfig);
bot.command('mode', handleConfig);
bot.command('set_destination', handleConfig);
bot.command('setup_reddit', handleConfig); // ✅ Add Command

// Logic
bot.on('text', async (ctx, next) => {
    if (await handleEditCaption(ctx)) return;
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await handleGroupMessage(ctx, () => handleMessage(ctx));
    } else {
        handleMessage(ctx);
    }
});

bot.on('callback_query', handleCallback);

// Start Engines
poller.init(bot);
redditRss.init(bot); // ✅ Start Reddit Poller

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

setupServer(bot);
