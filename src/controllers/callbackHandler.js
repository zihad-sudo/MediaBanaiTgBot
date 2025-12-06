const fs = require('fs');
const path = require('path');
const config = require('../config/settings');
const downloader = require('../utils/downloader');
const extractor = require('../services/extractors');
const db = require('../utils/db'); // IMPORT DB

// Services
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
        const sent = await ctx.replyWithPhoto(url).catch(async () => {
             // Fallback to local download if URL send fails
             const imgPath = path.join(config.DOWNLOAD_DIR, `${Date.now()}.jpg`);
             await downloader.downloadFile(url, imgPath);
             const s = await ctx.replyWithPhoto({ source: imgPath });
             fs.unlinkSync(imgPath);
             return s;
        });

        // CACHE PHOTO
        if(sent) db.setCache(url, sent.photo[sent.photo.length-1].file_id, 'photo');
        await ctx.deleteMessage();
    } 
    // --- ALBUM ---
    else if (action === 'alb') {
        await ctx.answerCbQuery("🚀 Processing...");
        const media = await extractor.extract(url);
        if (media?.type === 'gallery') {
            await ctx.deleteMessage();
            for (const item of media.items) {
                try { if(item.type==='video') await ctx.replyWithVideo(item.url); else await ctx.replyWithDocument(item.url); } catch {}
            }
        }
    } 
    // --- VIDEO ---
    else {
        await ctx.answerCbQuery("🚀 Downloading...");
        await ctx.editMessageText(`⏳ *Downloading...*`, { parse_mode: 'Markdown' });
        
        const timestamp = Date.now();
        const basePath = path.join(config.DOWNLOAD_DIR, `${timestamp}`);
        const isAudio = action === 'aud';
        const finalFile = `${basePath}.${isAudio ? 'mp3' : 'mp4'}`;

        try {
            if (id === 'best' && (url.includes('.mp4') || url.includes('.mp3'))) {
                await downloader.downloadFile(url, finalFile);
            } else {
                await downloader.download(url, isAudio, id, basePath);
            }

            const stats = fs.statSync(finalFile);
            if (stats.size > 49.5 * 1024 * 1024) {
                await ctx.editMessageText("⚠️ File > 50MB");
            } else {
                await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
                
                let sent;
                if (isAudio) sent = await ctx.replyWithAudio({ source: finalFile });
                else sent = await ctx.replyWithVideo({ source: finalFile }, { caption: '✨ Downloaded via Media Banai' });
                
                // CACHE VIDEO/AUDIO
                if (sent) {
                    const fileId = isAudio ? sent.audio.file_id : sent.video.file_id;
                    const type = isAudio ? 'audio' : 'video';
                    db.setCache(url, fileId, type);
                    db.addDownload();
                }

                await ctx.deleteMessage();
                console.log(`✅ Upload & Cache Complete`);
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