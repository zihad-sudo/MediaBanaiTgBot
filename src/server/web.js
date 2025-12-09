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
    const text = `👋 <b>Welcome to Media Banai!</b>\nI can download from Twitter, Reddit, Instagram & TikTok.\n\n<b>Features:</b>\n• Auto-Split Large Files\n• Ghost Mentions\n• Translation`;
    const buttons = Markup.inlineKeyboard([[Markup.button.callback('📚 Help', 'help_msg'), Markup.button.callback('📊 Stats', 'stats_msg')]]);
    if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'HTML', ...buttons }).catch(()=>{});
    else await ctx.reply(text, { parse_mode: 'HTML', ...buttons });
};

const handleHelp = async (ctx) => {
    const text = `📚 <b>Help Guide</b>\n\n<b>1. Downloads:</b> Send any valid link.\n<b>2. Custom Caption:</b> Add text after link.\n<b>3. Ghost Mention:</b> Reply + <code>/setnick name</code>.\n<b>4. Automation:</b> Use the Webhook API to send links silently.`;
    const buttons = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'start_msg')]]);
    if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'HTML', ...buttons }).catch(()=>{});
    else await ctx.reply(text, { parse_mode: 'HTML' });
};

// --- DOWNLOADER WITH SPLITTER ---
const performDownload = async (ctx, url, isAudio, qualityId, botMsgId, captionText, userMsgId) => {
    try {
        if (userMsgId && userMsgId !== 0) { try { await ctx.telegram.deleteMessage(ctx.chat.id, userMsgId); } catch (err) {} }
        await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, `⏳ *Downloading...*`, { parse_mode: 'Markdown' });

        const timestamp = Date.now();
        const basePath = path.join(config.DOWNLOAD_DIR, `${timestamp}`);
        const finalFile = `${basePath}.${isAudio ? 'mp3' : 'mp4'}`;

        await downloader.download(url, isAudio, qualityId, basePath);

        let filesToSend = [finalFile];
        const stats = fs.statSync(finalFile);
        if (!isAudio && stats.size > 49.5 * 1024 * 1024) {
            await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, "⚠️ *File > 50MB. Splitting...*", { parse_mode: 'Markdown' });
            try { filesToSend = await downloader.splitFile(finalFile); } 
            catch (e) { return await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, "❌ Split failed."); }
        }

        await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, "📤 *Uploading...*", { parse_mode: 'Markdown' });
        
        for (let i = 0; i < filesToSend.length; i++) {
            const file = filesToSend[i];
            let partCaption = captionText || '🚀 Media Banai';
            if (filesToSend.length > 1) partCaption += `\n\n🧩 <b>Part ${i + 1}/${filesToSend.length}</b>`;
            
            const extra = { caption: partCaption, parse_mode: 'HTML', ...(i === filesToSend.length - 1 ? getTranslationButtons() : {}) };
            if (isAudio) await ctx.replyWithAudio({ source: file }, extra);
            else await ctx.replyWithVideo({ source: file }, extra);
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }

        const userId = ctx.callbackQuery ? ctx.callbackQuery.from.id : (ctx.message ? ctx.message.from.id : null);
        if (userId) db.incrementDownloads(userId);

        await ctx.telegram.deleteMessage(ctx.chat.id, botMsgId).catch(() => {});

    } catch (e) {
        let errorMsg = "❌ Error/Timeout.";
        if (e.message.includes('403')) errorMsg = "❌ Error: Forbidden (Cookies needed?)";
        if (e.message.includes('Sign in')) errorMsg = "❌ Error: Age/Login Restricted.";
        
        await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, `${errorMsg}\n\nLog: \`${e.message.substring(0, 50)}...\``, { parse_mode: 'Markdown' });
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
            media = await twitterService.extract(fullUrl);
            platformName = 'Twitter';
            if (!media) media = { title: 'Twitter Media', author: 'User', source: fullUrl, type: 'video', url: fullUrl };
        } else if (fullUrl.includes('reddit.com')) {
            media = await redditService.extract(fullUrl);
            platformName = 'Reddit';
        } else {
            if (fullUrl.includes('instagram.com')) platformName = 'Instagram';
            if (fullUrl.includes('tiktok.com')) platformName = 'TikTok';
            try {
                const info = await downloader.getInfo(fullUrl);
                media = { title: info.title || 'Video', author: info.uploader || 'User', source: fullUrl, type: 'video', formats: info.formats || [] };
            } catch (e) { media = { title: 'Video', author: 'User', source: fullUrl, type: 'video', formats: [] }; }
        }

        if (!media) throw new Error("Media not found");

        // --- ✅ NEW LOGIC: ALWAYS SHOW BUTTONS ---
        const buttons = [];
        let previewText = `✅ ${flagEmoji} *${(media.title || 'Media').substring(0, 50)}...*`;

        if (media.type === 'gallery') {
            previewText += `\n📚 **Gallery Detected**`;
            buttons.push([Markup.button.callback(`📥 Download Album`, `alb|all`)]);
        } 
        else if (media.type === 'image') {
            previewText += `\n🖼 **Image Detected**`;
            buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single`)]);
        }
        else if (media.type === 'video') {
            previewText += `\n📹 **Video Detected**`;
            
            // Add Resolution Buttons (If available)
            if (media.formats && media.formats.length > 0) {
                const formats = media.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height);
                const seen = new Set();
                formats.slice(0, 5).forEach(f => {
                    if(!seen.has(f.height)) { 
                        seen.add(f.height); 
                        buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}`)]); 
                    }
                });
            }
            
            // Standard Buttons (Always visible)
            buttons.push([Markup.button.callback("📹 Download Video (Best)", "vid|best")]);
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|best")]);
        }
        
        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null, 
            `${previewText}\n👤 Author: ${media.author}\nSource: [Link](${media.source})`, 
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

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
    
    if (action === 'trans') {
        const msg = ctx.callbackQuery.message.caption;
        if (!msg) return ctx.answerCbQuery("No text");
        await ctx.answerCbQuery("Translating...");
        try {
            const res = await translate(msg.split('\n').slice(2).join('\n') || msg, { to: id, autoCorrect: true });
            const link = ctx.callbackQuery.message.caption_entities?.find(e=>e.type==='text_link')?.url || "http";
            await ctx.editMessageCaption(generateCaption(res.text, 'Social', link, '🇧🇩'), { parse_mode: 'HTML', ...getTranslationButtons() });
        } catch(e) { await ctx.answerCbQuery("Error"); }
        return;
    }

    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    if (!url) return ctx.answerCbQuery("Expired");

    if (action === 'img') { await ctx.answerCbQuery("Sending..."); await ctx.replyWithPhoto(url); await ctx.deleteMessage(); }
    else await performDownload(ctx, url, action === 'aud', id, ctx.callbackQuery.message.message_id, null, null);
};

module.exports = { handleMessage, handleCallback, handleGroupMessage, handleStart, handleHelp, performDownload };
