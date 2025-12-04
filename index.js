require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const https = require('https');

const execPromise = util.promisify(exec);

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const URL = process.env.RENDER_EXTERNAL_URL; // Auto-filled by Render

if (!BOT_TOKEN) {
    console.error("❌ Error: BOT_TOKEN is missing in environment variables.");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Ensure downloads directory exists
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

// Regex for Reddit and Twitter/X links
const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- UTILITIES ---

const formatBytes = (bytes, decimals = 2) => {
    if (!+bytes) return 'Unknown Size';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// Clean filename to prevent issues
const cleanFilename = (id) => `media_${id.replace(/[^a-z0-9]/gi, '_')}`;

// Execute yt-dlp command
const runYtDlp = async (args) => {
    // --no-warnings: clean output
    // --no-playlist: ensure we only get the single video
    // --user-agent: helps with twitter blocking
    const cmd = `yt-dlp --no-warnings --no-playlist --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" ${args}`;
    const { stdout } = await execPromise(cmd);
    return stdout;
};

// --- BOT COMMANDS ---

bot.start((ctx) => {
    ctx.reply(
        "👋 *Media Downloader Bot*\n\n" +
        "I can download videos from **Twitter (X)** and **Reddit**.\n" +
        "Simply paste a link to get started!",
        { parse_mode: 'Markdown' }
    );
});

// 1. LISTENER: Detect Links
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(URL_REGEX);

    if (!match) return; // No link found

    const url = match[0];
    const msg = await ctx.reply("🔍 *Analyzing link...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        // Fetch JSON metadata
        // -J: Dump JSON data
        const jsonOutput = await runYtDlp(`-J "${url}"`);
        const info = JSON.parse(jsonOutput);

        // Filter valid video formats (mp4) that have video data (height > 0)
        let formats = info.formats || [];
        
        // Filter: Must be MP4, must have video, remove m3u8 if possible (prefer direct mp4)
        const videoFormats = formats.filter(f => 
            f.ext === 'mp4' && 
            f.vcodec !== 'none' && 
            f.height
        );

        // Sort by resolution (High to Low)
        videoFormats.sort((a, b) => b.height - a.height);

        // Deduplicate resolutions (keep best bitrate per resolution)
        const uniqueQualities = [];
        const seenHeights = new Set();

        for (const fmt of videoFormats) {
            if (!seenHeights.has(fmt.height)) {
                seenHeights.add(fmt.height);
                uniqueQualities.push({
                    height: fmt.height,
                    filesize: fmt.filesize || fmt.filesize_approx || 0,
                    format_id: fmt.format_id
                });
            }
        }

        // Build Buttons
        const buttons = [];
        
        // Video Options
        uniqueQualities.slice(0, 5).forEach(q => {
            const sizeStr = formatBytes(q.filesize);
            // Callback data: type|format_id|height
            // We use a short identifier to stay within 64 byte limit
            buttons.push([Markup.button.callback(`🎬 ${q.height}p (${sizeStr})`, `v|${q.format_id}|${q.height}`)]);
        });

        // Audio Option
        buttons.push([Markup.button.callback("🎵 Audio Only (MP3)", "a|mp3")]);

        // Edit the "Analyzing" message with the menu
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            msg.message_id,
            null,
            `📹 *${info.title.substring(0, 50)}...*\n\nSource: ${info.extractor_key}\nSelect quality:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            }
        );

    } catch (error) {
        console.error("Analysis Error:", error);
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            msg.message_id,
            null,
            "❌ *Error:* Could not fetch media info.\nThe link might be private, deleted, or unsupported.",
            { parse_mode: 'Markdown' }
        );
    }
});

// 2. HANDLER: Button Clicks
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data.split('|');
    const type = data[0]; // 'v' for video, 'a' for audio
    const formatId = data[1];
    const quality = data[2] || 'Audio';

    // Get the original link from the message the bot replied to
    const replyMessage = ctx.callbackQuery.message.reply_to_message;
    if (!replyMessage || !replyMessage.text) {
        return ctx.answerCbQuery("❌ Error: Original link lost. Please send it again.");
    }
    
    const urlMatch = replyMessage.text.match(URL_REGEX);
    if (!urlMatch) return ctx.answerCbQuery("❌ Error: Invalid link.");
    const url = urlMatch[0];

    // UI Feedback
    await ctx.answerCbQuery("🚀 Processing...");
    await ctx.editMessageText(`⏳ *Downloading ${type === 'v' ? quality + 'p' : 'Audio'}...*\nPlease wait.`, { parse_mode: 'Markdown' });

    const timestamp = Date.now();
    const baseFilename = path.join(downloadDir, `${timestamp}`);
    let finalFilePath = "";

    try {
        if (type === 'a') {
            // Audio Download
            finalFilePath = `${baseFilename}.mp3`;
            // -x: Extract audio, --audio-format mp3
            await runYtDlp(`-x --audio-format mp3 -o "${baseFilename}.%(ext)s" "${url}"`);
        } else {
            // Video Download
            finalFilePath = `${baseFilename}.mp4`;
            // Download specific video format + best audio, merge into mp4
            // -S vcodec:h264 ensures Telegram compatibility (avoid av1/vp9 if possible)
            await runYtDlp(`-f ${formatId}+bestaudio/best -S vcodec:h264 --merge-output-format mp4 -o "${baseFilename}.%(ext)s" "${url}"`);
        }

        // Check File Size (Telegram Bot API limit is 50MB)
        const stats = fs.statSync(finalFilePath);
        const sizeMB = stats.size / (1024 * 1024);

        if (sizeMB > 49.5) {
            await ctx.editMessageText("⚠️ *File too large (Over 50MB).*\nTelegram bots cannot upload files larger than 50MB. Please try a lower quality.", { parse_mode: 'Markdown' });
        } else {
            await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
            
            if (type === 'a') {
                await ctx.replyWithAudio({ source: finalFilePath }, { caption: 'Downloaded by Media Bot' });
            } else {
                await ctx.replyWithVideo({ source: finalFilePath }, { caption: `🎥 ${quality}p\nDownloaded by Media Bot` });
            }
            await ctx.deleteMessage(); // Remove status message
        }

    } catch (err) {
        console.error("Download/Upload Error:", err);
        await ctx.editMessageText("❌ *Failed.* The server could not process this file.", { parse_mode: 'Markdown' });
    } finally {
        // Cleanup: Delete file after sending (or failing)
        if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
    }
});

// --- STARTUP ---

// Check if running on Render (Production) or Local
if (process.env.NODE_ENV === 'production' && URL) {
    console.log(`🚀 Setting up Webhook at ${URL}`);
    bot.launch({
        webhook: {
            domain: URL,
            port: PORT
        }
    }).then(() => console.log('✅ Webhook Active'));
} else {
    console.log('🚀 Starting Polling Mode');
    bot.launch();
}

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
