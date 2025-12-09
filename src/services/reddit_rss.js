const Parser = require('rss-parser');
const axios = require('axios');
const db = require('../utils/db');
const config = require('../config/settings');
const handlers = require('../utils/handlers');

const parser = new Parser();

const checkSaved = async (bot) => {
    const adminId = config.ADMIN_ID;
    const user = await db.getAdminConfig(adminId);

    // Default wait time if config fails (1 min)
    let nextCheckDelay = 60 * 1000; 

    // 1. Check if User exists and Feature is ON
    if (user && user.redditConfig) {
        
        // Update delay based on user setting (minutes -> ms)
        if (user.redditConfig.interval) {
            nextCheckDelay = user.redditConfig.interval * 60 * 1000;
        }

        // Only run logic if Active AND URL exists
        if (user.redditConfig.isActive && user.redditConfig.rssUrl) {
            try {
                console.log(`👽 Reddit RSS: Checking... (Next in ${user.redditConfig.interval} mins)`);
                
                // Fetch with Axios (User-Agent fix)
                const { data } = await axios.get(user.redditConfig.rssUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                    }
                });

                const feed = await parser.parseString(data);
                
                if (feed && feed.items && feed.items.length > 0) {
                    const newestItem = feed.items[0];
                    const newestId = newestItem.id || newestItem.link;
                    const lastId = user.redditConfig.lastPostId;

                    // Sync First Run
                    if (!lastId) {
                        console.log(`👽 Reddit Sync: ${newestId}`);
                        await db.updateRedditLastId(adminId, newestId);
                        await bot.telegram.sendMessage(adminId, `✅ <b>Reddit Sync Complete!</b>\nLast Post: ${newestId}`, { parse_mode: 'HTML' });
                    } 
                    // New Posts Found
                    else if (newestId !== lastId) {
                        const newPosts = [];
                        for (const item of feed.items) {
                            const currentId = item.id || item.link;
                            if (currentId === lastId) break;
                            newPosts.unshift(item);
                        }

                        if (newPosts.length > 0) {
                            console.log(`🔥 Processing ${newPosts.length} new Reddit posts.`);
                            for (const post of newPosts) {
                                const targetId = user.twitterConfig.webhookTarget || adminId;
                                const mockCtx = {
                                    from: { id: adminId, first_name: 'Admin' },
                                    chat: { id: targetId },
                                    message: { text: post.link, message_id: 0, from: { id: adminId } },
                                    reply: (text, extra) => bot.telegram.sendMessage(targetId, text, extra),
                                    telegram: bot.telegram,
                                    answerCbQuery: () => Promise.resolve(),
                                    replyWithVideo: (v, e) => bot.telegram.sendVideo(targetId, v, e),
                                    replyWithAudio: (a, e) => bot.telegram.sendAudio(targetId, a, e),
                                    replyWithPhoto: (p, e) => bot.telegram.sendPhoto(targetId, p, e),
                                    replyWithDocument: (d, e) => bot.telegram.sendDocument(targetId, d, e),
                                    editMessageMedia: (m, e) => bot.telegram.sendVideo(targetId, m.media.source, { caption: m.caption, parse_mode: 'HTML' })
                                };

                                await handlers.handleMessage(mockCtx);
                                await new Promise(r => setTimeout(r, 5000));
                            }
                            await db.updateRedditLastId(adminId, newestId);
                        }
                    } else {
                        console.log("💤 Reddit RSS: No new posts.");
                    }
                }
            } catch (e) {
                console.error("❌ Reddit Error:", e.message);
            }
        } else {
            console.log("💤 Reddit RSS: OFF (Waiting for activation)");
        }
    }

    // Recursive Loop: Run this function again after 'nextCheckDelay'
    setTimeout(() => checkSaved(bot), nextCheckDelay);
};

const init = (bot) => {
    console.log("🚀 Reddit RSS Engine Started");
    checkSaved(bot); // Start the loop
};

module.exports = { init };
