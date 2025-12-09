const { Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const config = require('../config/settings');
const { translate } = require('google-translate-api-x');
const db = require('./db');
const { resolveRedirect } = require('./helpers'); 
const downloader = require('./downloader');
const redditService = require('../services/reddit');
const twitterService = require('../services/twitter');

// --- HELPERS ---
const getFlagEmoji = (code) => {
    if (!code || code.length !== 2) return '🇧🇩';
    return code.toUpperCase().replace(/./g, char => String.fromCodePoint(char.charCodeAt(0) + 127397));
};

const generateCaption = (text, platform, sourceUrl, flagEmoji) => {
    const cleanText = text ? (text.length > 900 ? text.substring(0, 897) + '...' : text) : "Media Content";
    const safeText = cleanText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const validFlag = flagEmoji || '🇧🇩';
    return `🎬 <b>${platform} media</b> | <a href="${sourceUrl}">source</a> ${validFlag}\n\n<blockquote>${safeText}</blockquote>`;
};

const getTranslationButtons = () => {
    return Markup.inlineKeyboard([[Markup.button.callback('🇺🇸 English', 'trans|en'), Markup.button.callback('🇧🇩 Bangla', 'trans|bn')]]);
};

// --- START & HELP ---
const handleStart = async (ctx) => {
    db.addUser(ctx);
    const text = `👋 <b>Welcome to Media Banai!</b>\nI can download from Twitter, Reddit, Instagram & TikTok.\n\n<b>Features:</b>\n• Auto-Split Large Files\n• Real Thumbnails\n• Translation`;
    const buttons = Markup.inlineKeyboard([[Markup.button.callback('📚 Help', 'help_msg'), Markup.button.callback('📊 Stats', 'stats_msg')]]);
    if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'HTML', ...buttons }).catch(()=>{});
    else await ctx.reply(text, { parse_mode: 'HTML', ...buttons });
};

const handleHelp = async (ctx) => {
    const text = `📚 <b>Help Guide</b>\n\n<b>1. Downloads:</b> Send any valid link.\n<b>2. Config:</b> /setup_reddit, /reddit_on, /reddit_off.\n<b>3. Automation:</b> /setup_api, /mode webhook.`;
    const buttons = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'start_msg')]]);
    if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'HTML', ...buttons }).catch(()=>{});
    else await ctx.reply(text, { parse_mode: 'HTML' });
};

// --- CONFIG HANDLER (UPDATED) ---
const handleConfig = async (ctx) => {
    if (String(ctx.from.id) !== String(config.ADMIN_ID)) return;
    const text = ctx.message.text;

    // REDDIT CONTROLS
    if (text.startsWith('/setup_reddit')) {
        const parts = text.split(' ');
        if (parts.length < 2) return ctx.reply("⚠️ Usage: `/setup_reddit RSS_URL`", { parse_mode: 'Markdown' });
        await db.updateRedditConfig(ctx.from.id, parts[1]);
        return ctx.reply("✅ <b>Reddit Configured!</b>\nStatus: ON\nInterval: 2 mins", { parse_mode: 'HTML' });
    }
    if (text === '/reddit_on') {
        await db.toggleRedditMode(ctx.from.id, true);
        return ctx.reply("🟢 <b>Reddit Feed: ON</b>", { parse_mode: 'HTML' });
    }
    if (text === '/reddit_off') {
        await db.toggleRedditMode(ctx.from.id, false);
        return ctx.reply("🔴 <b>Reddit Feed: OFF</b>", { parse_mode: 'HTML' });
    }
    if (text.startsWith('/reddit_interval')) {
        const parts = text.split(' ');
        const mins = parseInt(parts[1]);
        if (!mins || mins < 1) return ctx.reply("⚠️ Usage: `/reddit_interval 10` (Min 1)", { parse_mode: 'Markdown' });
        await db.setRedditInterval(ctx.from.id, mins);
        return ctx.reply(`⏱️ <b>Interval Updated!</b>\nChecking every ${mins} minutes.`, { parse_mode: 'HTML' });
    }

    // OTHER CONTROLS (Destination / API)
    if (text.startsWith('/set_destination')) {
        let targetId = ctx.chat.id;
        let title = ctx.chat.title || "Private Chat";
        if (text.includes('reset')) { targetId = ""; title = "Default"; }
        await db.setWebhookTarget(config.ADMIN_ID, targetId);
        return ctx.reply(`✅ Target: <b>${title}</b>`, { parse_mode: 'HTML' });
    }
    if (text.startsWith('/setup_api')) {
        const parts = text.split(' ');
        if (parts.length < 3) return ctx.reply("Usage: /setup_api KEY USER");
        await db.updateApiConfig(ctx.from.id, parts[1], parts[2]);
        return ctx.reply("✅ API Configured!");
    }
    if (text.startsWith('/mode')) {
        const mode = text.split(' ')[1];
        await db.toggleMode(ctx.from.id, mode);
        return ctx.reply(`🔄 Mode: <b>${mode}</b>`, { parse_mode: 'HTML' });
    }
};

// ... (KEEP THE REST OF THE FILE: handleEditCaption, performDownload, handleMessage, etc. EXACTLY AS BEFORE)
// I am truncating the bottom to save space, but DO NOT DELETE the rest of your handlers file.
// Just insert the new 'handleConfig' logic above into your existing file.

// Wait, I will provide full file to avoid errors.
// --- CAPTION EDITOR ---
const handleEditCaption = async (ctx) => {
    const text = ctx.message.text;
    if (!text || !text.startsWith('/caption')) return false;
    if (!ctx.message.reply_to_message || ctx.message.reply_to_message.from.id !== ctx.botInfo.id) return true;
    const newCaption = text.replace(/^\/caption\s*/, '').trim();
    if (!newCaption) return true;
    try {
        await ctx.telegram.editMessageCaption(ctx.chat.id, ctx.message.reply_to_message.message_id, null, newCaption, { parse_mode: 'HTML', reply_markup: ctx.message.reply_to_message.reply_markup });
        await ctx.deleteMessage().catch(()=>{});
        const confirm = await ctx.reply("✅ Updated!");
        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, confirm.message_id).catch(()=>{}), 2000);
    } catch (e) {}
    return true;
};

// --- DOWNLOADER ---
const performDownload = async (ctx, url, isAudio, qualityId, botMsgId, captionText, userMsgId) => {
    try {
        if (userMsgId && userMsgId !== 0) { try { await ctx.telegram.deleteMessage(ctx.chat.id, userMsgId); } catch (err) {} }
        try { await ctx.telegram.editMessageCaption(ctx.chat.id, botMsgId, null, "⏳ <b>Downloading...</b>", { parse_mode: 'HTML' }); } catch (e) {}

        const timestamp = Date.now();
        const basePath = path.join(config.DOWNLOAD_DIR, `${timestamp}`);
        const finalFile = `${basePath}.${isAudio ? 'mp3' : 'mp4'}`;

        await downloader.download(url, isAudio, qualityId, basePath);

        let filesToSend = [finalFile];
        const stats = fs.statSync(finalFile);
        if (!isAudio && stats.size > 49.5 * 1024 * 1024) {
            await ctx.telegram.editMessageCaption(ctx.chat.id, botMsgId, null, "⚠️ <b>File > 50MB. Splitting...</b>", { parse_mode: 'HTML' });
            try { filesToSend = await downloader.splitFile(finalFile); } 
            catch (e) { return await ctx.telegram.editMessageCaption(ctx.chat.id, botMsgId, null, "❌ Split failed.", { parse_mode: 'HTML' }); }
        }

        for (let i = 0; i < filesToSend.length; i++) {
            const file = filesToSend[i];
            if (i === 0) {
                try {
                    await ctx.telegram.editMessageMedia(
                        ctx.chat.id, botMsgId, null,
                        { type: isAudio ? 'audio' : 'video', media: { source: file }, caption: captionText, parse_mode: 'HTML' },
                        { ...getTranslationButtons().reply_markup } 
                    );
                } catch (editError) {
                    await ctx.telegram.deleteMessage(ctx.chat.id, botMsgId).catch(()=>{});
                    if (isAudio) await ctx.replyWithAudio({ source: file }, { caption: captionText, parse_mode: 'HTML', ...getTranslationButtons() });
                    else await ctx.replyWithVideo({ source: file }, { caption: captionText, parse_mode: 'HTML', ...getTranslationButtons() });
                }
            } else {
                let partCaption = captionText + `\n\n🧩 <b>Part ${i + 1}</b>`;
                if (isAudio) await ctx.replyWithAudio({ source: file }, { caption: partCaption, parse_mode: 'HTML' });
                else await ctx.replyWithVideo({ source: file }, { caption: partCaption, parse_mode: 'HTML' });
            }
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        const userId = ctx.callbackQuery ? ctx.callbackQuery.from.id : (ctx.message ? ctx.message.from.id : null);
        if (userId) db.incrementDownloads(userId);
    } catch (e) {
        let errorMsg = "❌ Error/Timeout.";
        if (e.message.includes('403')) errorMsg = "❌ Error: Forbidden (Check Cookies)";
        if (e.message.includes('Sign in')) errorMsg = "❌ Error: Login Required (Check Cookies)";
        try { await ctx.telegram.editMessageCaption(ctx.chat.id, botMsgId, null, `${errorMsg}\n\nLog: \`${e.message.substring(0, 50)}...\``, { parse_mode: 'Markdown' }); } 
        catch { await ctx.reply(`${errorMsg}`, { parse_mode: 'Markdown' }); }
        const basePath = path.join(config.DOWNLOAD_DIR, `${Date.now()}`);
        if (fs.existsSync(`${basePath}.mp4`)) fs.unlinkSync(`${basePath}.mp4`);
    }
};

const handleMessage = async (ctx) => {
    db.addUser(ctx);
    const messageText = ctx.message.text;
    if (!messageText) return; 
    const match = messageText.match(config.URL_REGEX);
    if (!match) return;

    const inputUrl = match[0];
    const parts = messageText.split(inputUrl);
    const preText = parts[0].trim(); 
    const postText = parts[1].trim(); 
    let flagEmoji = (preText.length === 2 && /^[a-zA-Z]+$/.test(preText)) ? getFlagEmoji(preText) : '🇧🇩';

    const msg = await ctx.reply("🔍 *Analyzing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const fullUrl = await resolveRedirect(inputUrl);
        let media = null;
        let platformName = 'Social';

        if (fullUrl.includes('x.com') || fullUrl.includes('twitter.com')) {
            platformName = 'Twitter';
            try {
                const info = await downloader.getInfo(fullUrl);
                media = { title: info.title || 'Twitter Media', author: info.uploader || 'Twitter User', source: fullUrl, type: 'video', url: fullUrl, thumbnail: info.thumbnail, formats: info.formats || [] };
            } catch (e) { media = await twitterService.extract(fullUrl); }
        } else if (fullUrl.includes('reddit.com')) {
            media = await redditService.extract(fullUrl);
            platformName = 'Reddit';
        } else {
            if (fullUrl.includes('instagram.com')) platformName = 'Instagram';
            if (fullUrl.includes('tiktok.com')) platformName = 'TikTok';
            try {
                const info = await downloader.getInfo(fullUrl);
                media = { title: info.title || 'Social Video', author: info.uploader || 'User', source: fullUrl, type: 'video', url: fullUrl, thumbnail: info.thumbnail, formats: info.formats || [] };
            } catch (e) { media = { title: 'Video', author: 'User', source: fullUrl, type: 'video', formats: [] }; }
        }

        if (!media) throw new Error("Media not found");

        const prettyCaption = generateCaption(postText || media.title, platformName, media.source, flagEmoji);

        const buttons = [];
        if (media.type === 'video') {
            if (media.formats && media.formats.length > 0) {
                const formats = media.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height);
                const seen = new Set();
                formats.slice(0, 5).forEach(f => {
                    if(!seen.has(f.height)) { seen.add(f.height); buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}`)]); }
                });
            }
            buttons.push([Markup.button.callback("📹 Download Video (Best)", "vid|best")]);
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|best")]);
        }
        else if (media.type === 'gallery') buttons.push([Markup.button.callback(`📥 Download Album`, `alb|all`)]);
        else if (media.type === 'image') buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single`)]);

        const menuMarkup = Markup.inlineKeyboard([...buttons, ...getTranslationButtons().reply_markup.inline_keyboard]);

        if (media.thumbnail) {
            await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(()=>{});
            await ctx.replyWithPhoto(media.thumbnail, { caption: prettyCaption, parse_mode: 'HTML', ...menuMarkup });
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `${prettyCaption}`, { parse_mode: 'HTML', ...menuMarkup });
        }

    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed: " + e.message);
    }
};

const handleGroupMessage = async (ctx, next) => {
    const messageText = ctx.message.text;
    if (messageText && messageText.startsWith('/setnick')) {
        const parts = messageText.split(' ');
        if (parts.length < 2 || !ctx.message.reply_to_message) return ctx.reply("Usage: Reply + /setnick name");
        await db.setNickname(ctx.chat.id, parts[1].toLowerCase(), ctx.message.reply_to_message.from.id);
        return ctx.reply(`✅ Saved: ${parts[1]}`);
    }
    if (messageText && messageText.startsWith('/delnick')) {
        const parts = messageText.split(' ');
        if (parts.length < 2) return;
        await db.deleteNickname(ctx.chat.id, parts[1]);
        return ctx.reply(`🗑 Deleted: ${parts[1]}`);
    }
    if (messageText) {
        const nickEntry = await db.getNickname(ctx.chat.id, messageText.trim().toLowerCase());
        if (nickEntry) {
            try { await ctx.deleteMessage(); } catch(e){}
            await ctx.reply(`👋 <b>${ctx.from.first_name}</b> mentioned <a href="tg://user?id=${nickEntry.targetId}">User</a>`, { parse_mode: 'HTML' });
            return;
        }
    }
    return next();
};

const handleCallback = async (ctx) => {
    db.addUser(ctx);
    const [action, id] = ctx.callbackQuery.data.split('|');
    if (action === 'help_msg') return handleHelp(ctx);
    if (action === 'start_msg') return handleStart(ctx);
    if (action === 'stats_msg') return ctx.answerCbQuery("Use /stats", { show_alert: true });
    
    const entities = ctx.callbackQuery.message.caption_entities || ctx.callbackQuery.message.entities;
    const url = entities?.find(e => e.type === 'text_link')?.url;

    if (action === 'trans') {
        const msg = ctx.callbackQuery.message.caption;
        if (!msg) return ctx.answerCbQuery("No text");
        await ctx.answerCbQuery("Translating...");
        try {
            const res = await translate(msg.split('\n').slice(2).join('\n') || msg, { to: id, autoCorrect: true });
            const link = url || "http"; 
            await ctx.editMessageCaption(generateCaption(res.text, 'Social', link, '🇧🇩'), { parse_mode: 'HTML', ...getTranslationButtons() });
        } catch(e) { await ctx.answerCbQuery("Error"); }
        return;
    }

    if (!url) return ctx.answerCbQuery("Expired. Send link again.");

    if (action === 'img') { await ctx.answerCbQuery("Sending..."); await ctx.replyWithPhoto(url); await ctx.deleteMessage(); }
    else await performDownload(ctx, url, action === 'aud', id, ctx.callbackQuery.message.message_id, ctx.callbackQuery.message.caption, null);
};

module.exports = { 
    handleMessage, handleCallback, handleGroupMessage, handleStart, handleHelp, performDownload, handleConfig, handleEditCaption 
};
