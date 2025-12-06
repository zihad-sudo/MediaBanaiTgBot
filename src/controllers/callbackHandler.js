const fs = require('fs');
const path = require('path');
const config = require('../config/settings');
const downloader = require('../utils/downloader');
const extractor = require('../services/extractors');

// Services for re-extraction
const redditService = require('../services/reddit');
const twitterService = require('../services/twitter');
const instagramService = require('../services/instagram');
const tiktokService = require('../services/tiktok');

const handleCallback = async (ctx) => {
    const [action, id] = ctx.callbackQuery.data.split('|');
    const url = ctx.callbackQuery.message.entities?.find(e => e.type === 'text_link')?.url;
    
    if (!url) return ctx.answerCbQuery("❌ Expired");

    // --- IMAGE ---
    if (action === 'img') {
        await ctx.answerCbQuery("🚀 Downloading...");
        const imgPath = path.join(config.DOWNLOAD_DIR, `${Date.now()}.jpg`);
        try {
            await downloader.downloadFile(url, imgPath);
            await ctx.replyWithPhoto({ source: imgPath });
            await ctx.deleteMessage();
        } catch (e) {
            try { await ctx.replyWithDocument(url); } catch {}
        } finally {
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        }
    } 
    // --- ALBUM ---
    else if (action === 'alb') {
        await ctx.answerCbQuery("🚀 Processing...");
        await ctx.editMessageText("⏳ *Fetching Album...*", { parse_mode: 'Markdown' });
        
        let media = null;
        if (url.includes('tiktok.com')) media = await tiktokService.extract(url);
        else if (url.includes('instagram.com')) media = await instagramService.extract(url);
        else if (url.includes('x.com')) media = await twitterService.extract(url);
        else media = await redditService.extract(url);

        if (media?.type === 'gallery') {
            await ctx.editMessageText(`📤 *Sending ${media.items.length} items...*`, { parse_mode: 'Markdown' });
            for (const item of media.items) {
                try {
                    if (item.type === 'video') await ctx.replyWithVideo(item.url);
                    else {
                        const tmpName = path.join(config.DOWNLOAD_DIR, `gal_${Date.now()}_${Math.random()}.jpg`);
                        await downloader.downloadFile(item.url, tmpName);
                        await ctx.replyWithDocument({ source: tmpName });
                        fs.unlinkSync(tmpName);
                    }
                } catch (e) {}
            }
            await ctx.deleteMessage();
        } else {
            await ctx.editMessageText("❌ Failed.");
        }
    } 
    // --- VIDEO ---
    else {
        await ctx.answerCbQuery("🚀 Downloading...");
        await ctx.editMessageText(`⏳ *Downloading...*`, { parse_mode: 'Markdown' });
        
        const basePath = path.join(config.DOWNLOAD_DIR, `${Date.now()}`);
        const isAudio = action === 'aud';
        const finalFile = `${basePath}.${isAudio ? 'mp3' : 'mp4'}`;

        try {
            if (id === 'best' && (url.includes('.mp4') || url.includes('.mp3'))) {
                await downloader.downloadFile(url, finalFile);
            } else {
                await downloader.download(url, isAudio, id, basePath);
            }

            const stats = fs.statSync(finalFile);
            if (stats.size > 49.5 * 1024 * 1024) await ctx.editMessageText("⚠️ File > 50MB");
            else {
                await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
                if (isAudio) await ctx.replyWithAudio({ source: finalFile });
                else await ctx.replyWithVideo({ source: finalFile });
                await ctx.deleteMessage();
            }
        } catch (e) {
            console.error("DL Error:", e);
            await ctx.editMessageText("❌ Error.");
        } finally {
            if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
        }
    }
};

module.exports = { handleCallback };