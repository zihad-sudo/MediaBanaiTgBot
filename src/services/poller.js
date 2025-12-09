const axios = require('axios');
const db = require('../utils/db');
const config = require('../config/settings');
const handlers = require('../utils/handlers');

const checkLikes = async (bot) => {
    const adminId = config.ADMIN_ID;
    const user = await db.getAdminConfig(adminId);

    // 1. Check if Mode is API
    if (!user || user.twitterConfig.mode !== 'api' || !user.twitterConfig.apiKey) {
        return; // Silent exit if mode is webhook or off
    }

    try {
        // 2. Call API (Fetch last 5 likes)
        const response = await axios.get(`https://api.twitterapi.io/twitter/user/last_likes`, {
            params: { userName: user.twitterConfig.targetHandle },
            headers: { 'X-API-Key': user.twitterConfig.apiKey }
        });

        // Note: Structure depends on API. Usually returns { likes: [...] } or just array
        // We handle generic response. Assuming it returns list of tweets.
        const tweets = response.data.likes || response.data.tweets || [];
        if (tweets.length === 0) return;

        // 3. Process IDs
        const lastIdStr = user.twitterConfig.lastLikedId || "0";
        const lastId = BigInt(lastIdStr);
        
        // Safety: Sort tweets from Oldest -> Newest
        tweets.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));

        // Get the absolute newest ID from this batch
        const newestInBatch = tweets[tweets.length - 1].id;

        // **FIRST RUN CHECK**: If we never ran before, just save the newest ID and skip download.
        // This prevents downloading 20 old posts instantly.
        if (lastId === 0n) {
            console.log(`✨ First Run: Marking ${newestInBatch} as start point.`);
            await db.updateLastId(adminId, newestInBatch);
            return;
        }

        // 4. Filter & Download
        let foundNew = false;
        for (const tweet of tweets) {
            // Only process if this tweet is NEWER than what we have seen
            if (BigInt(tweet.id) > lastId) {
                foundNew = true;
                const tweetUrl = `https://twitter.com/${user.twitterConfig.targetHandle}/status/${tweet.id}`;
                console.log(`🔥 New Like Detected: ${tweetUrl}`);

                // Create Mock Context
                const mockCtx = {
                    from: { id: adminId, first_name: 'Admin', is_bot: false },
                    chat: { id: adminId, type: 'private' },
                    message: { text: tweetUrl, message_id: 0, from: { id: adminId } },
                    reply: (text, extra) => bot.telegram.sendMessage(adminId, text, extra),
                    telegram: bot.telegram,
                    answerCbQuery: () => Promise.resolve(),
                    replyWithVideo: (v, e) => bot.telegram.sendVideo(adminId, v, e),
                    replyWithAudio: (a, e) => bot.telegram.sendAudio(adminId, a, e),
                    replyWithPhoto: (p, e) => bot.telegram.sendPhoto(adminId, p, e),
                    replyWithDocument: (d, e) => bot.telegram.sendDocument(adminId, d, e),
                };

                // Trigger Bot
                await handlers.handleMessage(mockCtx);
                
                // Small delay to be safe
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // 5. Update DB with newest ID (only if we found something new)
        if (foundNew) {
            await db.updateLastId(adminId, newestInBatch);
        }

    } catch (e) {
        console.error("❌ Poller Error:", e.message);
    }
};

const init = (bot) => {
    console.log("🚀 Polling Engine Started (1 min interval)");
    // Run once on start
    checkLikes(bot);
    // Run every 60 seconds (1 minute)
    setInterval(() => checkLikes(bot), 60 * 1000);
};

module.exports = { init };