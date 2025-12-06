const { Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const config = require('../config/settings');
const { translate } = require('google-translate-api-x');

const { resolveRedirect } = require('./helpers'); 
const downloader = require('./downloader');
const redditService = require('../services/reddit');
const twitterService = require('../services/twitter');

// --- HELPER: GENERATE UI CAPTION ---
const generateCaption = (text, platform, sourceUrl) => {
    // 1. Clean Text
    const cleanText = text ? (text.length > 900 ? text.substring(0, 897) + '...' : text) : "Media Content";
    // 2. Escape HTML
    const safeText = cleanText.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 3. UI Template
    return `🎬 <b>${platform} media</b> | <a href="${sourceUrl}">source</a>\n\n<blockquote>${safeText}</blockquote>`;
};

// --- HELPER: BUTTONS ---
const getTranslationButtons = () => {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('🇺🇸 English', 'trans|en'),
            Markup.button.callback('🇧🇩 Bangla', 'trans|bn')
        ]
    ]);
};

// --- SHARED DOWNLOAD FUNCTION ---
const performDownload = async (ctx, url, isAudio, qualityId, botMsgId, captionText, userMsgId) => {
    try {
        if (userMsgId) {
            try { await ctx.telegram.deleteMessage(ctx.chat.id, userMsgId); } catch (err) {}
        }

        await ctx.telegram.editMessageText(
            ctx.chat.id, botMsgId, null, 
            `⏳ *Downloading...*\n_Creating your masterpiece..._`, 
            { parse_mode: 'Markdown' }
        );

        const timestamp = Date.now();
        const basePath = path.join(config.DOWNLOAD_DIR, `${timestamp}`);
        const finalFile = `${basePath}.${isAudio ? 'mp3' : 'mp4'}`;

        console.log(`⬇️ Starting Download: ${url}`);
        await downloader.download(url, isAudio, qualityId, basePath);

        const stats = fs.statSync(finalFile);
        if (stats.size > 49.5 * 1024 * 1024) {
            await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, "⚠️ File > 50MB (Telegram Limit).");
            if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
            return;
        }

        await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, "📤 *Uploading...*", { parse_mode: 'Markdown' });
        
        // --- ADD DUAL TRANSLATE BUTTONS ---
        const extraOptions = { 
            caption: captionText || '🚀 Downloaded via Media Banai',
            parse_mode: 'HTML',
            ...getTranslationButtons()
        };

        if (isAudio) {
            await ctx.replyWithAudio({ source: finalFile }, extraOptions);
        } else {
            await ctx.replyWithVideo({ source: finalFile }, extraOptions);
        }

        console.log(`✅ Upload Success: ${url}`);
        await ctx.telegram.deleteMessage(ctx.chat.id, botMsgId).catch(() => {});
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);

    } catch (e) {
        console.error(`Download Error: ${e.message}`);
        await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, "❌ Error during download.");
        const basePath = path.join(config.DOWNLOAD_DIR, `${Date.now()}`);
        if (fs.existsSync(`${basePath}.mp4`)) fs.unlinkSync(`${basePath}.mp4`);
    }
};

// --- MESSAGE HANDLER ---
const handleMessage = async (ctx) => {
    const messageText = ctx.message.text;
    const match = messageText.match(config.URL_REGEX);
    if (!match) return;

    const inputUrl = match[0];
    const userCustomCaption = messageText.replace(inputUrl, '').trim();

    console.log(`📩 New Request: ${inputUrl}`);
    const msg = await ctx.reply("🔍 *Analyzing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const fullUrl = await resolveRedirect(inputUrl);
        let media = null;
        let platformName = 'Social';

        if (fullUrl.includes('x.com') || fullUrl.includes('twitter.com')) {
            media = await twitterService.extract(fullUrl);
            platformName = 'Twitter';
        } else {
            media = await redditService.extract(fullUrl);
            platformName = 'Reddit';
        }

        if (!media) throw new Error("Media not found");

        const safeUrl = media.url || media.source;
        const finalTitleText = userCustomCaption.length > 0 ? userCustomCaption : media.title;
        
        const prettyCaption = generateCaption(finalTitleText, platformName, media.source);

        // --- AUTO-DOWNLOAD ---
        if (media.type === 'video' && (!media.formats || media.formats.length === 0)) {
            console.log("⚠️ No resolutions found. Auto-Downloading.");
            return await performDownload(ctx, safeUrl, false, 'best', msg.message_id, prettyCaption, ctx.message.message_id);
        }

        // --- BUTTONS MENU ---
        const buttons = [];
        let previewText = `✅ *${finalTitleText.substring(0, 50)}...*`;

        if (media.type === 'gallery') {
            previewText += `\n📚 **Gallery:** ${media.items.length} items`;
            buttons.push([Markup.button.callback(`📥 Download Album`, `alb|all`)]);
        } 
        else if (media.type === 'image') {
            previewText += `\n🖼 **Image Detected**`;
            buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single`)]);
        } 
        else if (media.type === 'video') {
            const formats = media.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height);
            const seen = new Set();
            formats.slice(0, 5).forEach(f => {
                if(!seen.has(f.height)) {
                    seen.add(f.height);
                    buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}`)]);
                }
            });
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|best")]);
        }

        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `${previewText}\n👤 Author: ${media.author}\nSource: [Link](${safeUrl})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (e) {
        console.error(`Processing Error: ${e.message}`);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Content unavailable.");
    }
};

// --- CALLBACK HANDLER ---
const handleCallback = async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, id] = data.split('|');
    
    // --- TRANSLATE BUTTON LOGIC (Dynamic Lang) ---
    if (action === 'trans') {
        const targetLang = id; // 'en' or 'bn'
        const messageCaption = ctx.callbackQuery.message.caption;
        const entities = ctx.callbackQuery.message.caption_entities;
        
        if (!messageCaption) return ctx.answerCbQuery("No text to translate.");

        await ctx.answerCbQuery(targetLang === 'bn' ? "🇧🇩 Translating..." : "🇺🇸 Translating...");

        // 1. Recover Source URL
        const linkEntity = entities?.find(e => e.type === 'text_link');
        const sourceUrl = linkEntity ? linkEntity.url : "https://google.com";
        
        // 2. Recover Platform Name
        let platform = 'Social';
        if (messageCaption.toLowerCase().includes('twitter')) platform = 'Twitter';
        else if (messageCaption.toLowerCase().includes('reddit')) platform = 'Reddit';

        // 3. Extract Content
        const lines = messageCaption.split('\n');
        let contentToTranslate = messageCaption;
        if (lines.length > 2) {
            contentToTranslate = lines.slice(2).join('\n').trim();
        }

        try {
            // 4. Translate to dynamic target language
            const res = await translate(contentToTranslate, { to: targetLang, autoCorrect: true });
            
            // 5. Update Caption
            const newCaption = generateCaption(res.text, platform, sourceUrl);
            
            // We keep the buttons so user can switch between English and Bangla
            await ctx.editMessageCaption(newCaption, { 
                parse_mode: 'HTML',
                ...getTranslationButtons()
            });
            
        } catch (e) {
            console.error("Translation Error", e);
            await ctx.answerCbQuery("❌ Translation failed.");
        }
        return;
    }

    // --- STANDARD LOGIC ---
    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    if (!url) return ctx.answerCbQuery("❌ Link expired.");

    let platformName = 'Social';
    if (url.includes('twitter') || url.includes('x.com')) platformName = 'Twitter';
    else if (url.includes('reddit')) platformName = 'Reddit';

    let titleToUse = "Media Content";
    const msgText = ctx.callbackQuery.message.text;
    if (msgText) {
        const firstLine = msgText.split('\n')[0];
        titleToUse = firstLine.replace('✅ ', '');
    }

    const niceCaption = generateCaption(titleToUse, platformName, url);
    const userOriginalMsgId = ctx.callbackQuery.message.reply_to_message?.message_id;

    if (action === 'img') {
        await ctx.answerCbQuery("🚀 Sending...");
        try { 
            await ctx.replyWithPhoto(url, { 
                caption: niceCaption, 
                parse_mode: 'HTML',
                ...getTranslationButtons() // Add buttons to image too
            });
            if(userOriginalMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, userOriginalMsgId).catch(()=>{});
        } 
        catch { 
            await ctx.replyWithDocument(url, { 
                caption: niceCaption, 
                parse_mode: 'HTML',
                ...getTranslationButtons() 
            }); 
        }
        await ctx.deleteMessage();
    }
    else if (action === 'alb') {
        await ctx.answerCbQuery("🚀 Processing...");
        let media = null;
        if (url.includes('x.com') || url.includes('twitter')) media = await twitterService.extract(url);
        else media = await redditService.extract(url);

        if (media?.type === 'gallery') {
            await ctx.deleteMessage();
            if(userOriginalMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, userOriginalMsgId).catch(()=>{});
            for (const item of media.items) {
                try {
                    if(item.type==='video') await ctx.replyWithVideo(item.url);
                    else await ctx.replyWithDocument(item.url);
                } catch {}
            }
        }
    }
    else {
        await ctx.answerCbQuery("🚀 Downloading...");
        await performDownload(ctx, url, action === 'aud', id, ctx.callbackQuery.message.message_id, niceCaption, userOriginalMsgId);
    }
};

module.exports = { handleMessage, handleCallback };