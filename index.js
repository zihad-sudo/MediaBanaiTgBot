require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const URL = process.env.RENDER_EXTERNAL_URL; // Render sets this automatically
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
    console.error("❌ BOT_TOKEN is missing!");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Ensure downloads directory exists
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

// Regex to find Reddit or Twitter/X links
const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- HELPER FUNCTIONS ---

// Format bytes to MB/GB
const formatBytes = (bytes, decimals = 2) => {
    if (!+bytes) return 'Unknown';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
};

// Run yt-dlp command
const runYtDlp = async (args) => {
    // --no-playlist: only download the single video
    // --no-warnings: keep logs clean
    const cmd = `yt-dlp --no-warnings --no-playlist --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" ${args}`;
    const { stdout } = await execPromise(cmd);
    return stdout;
};

// --- BOT HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Send me a Reddit or Twitter (X) link to download the video!"));

// 1. Listen for Links
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(URL_REGEX);
    if (!match) return; 

    const url = match[0];
    const msg = await ctx.reply("🔍 *Searching for video...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        // Get Metadata in JSON format
        const jsonOutput = await runYtDlp(`-J "${url}"`);
        const info = JSON.parse(jsonOutput);

        // Filter for MP4 videos with resolution
        const formats = (info.formats || []).filter(f => f.ext === 'mp4' && f.height);
        
        // Remove duplicate resolutions (keep only one per height)
        const uniqueQualities = [];
        const seenHeights = new Set();
        // Sort high to low
        formats.sort((a, b) => b.height - a.height);

        for (const fmt of formats) {
            if (!seenHeights.has(fmt.height)) {
                seenHeights.add(fmt.height);
                uniqueQualities.push({
                    height: fmt.height,
                    filesize: fmt.filesize || fmt.filesize_approx || 0,
                    id: fmt.format_id
                });
            }
        }

        // Create Buttons
        const buttons = [];
        // Limit to top 5 qualities to save space
        uniqueQualities.slice(0, 5).forEach(q => {
            const size = formatBytes(q.filesize);
            buttons.push([Markup.button.callback(`📹 ${q.height}p (${size})`, `video|${q.id}|${q.height}`)]);
        });
        buttons.push([Markup.button.callback("🎵 Audio Only (MP3)", "audio|mp3")]);

        // Show options
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            msg.message_id,
            null,
            `✅ Found: *${info.title.substring(0, 40)}...*\nChoose quality:`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error(err);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Could not find media. The link might be invalid or private.");
    }
});

// 2. Handle Button Click
bot.on('callback_query', async (ctx) => {
    const [type, id, quality] = ctx.callbackQuery.data.split('|');
    
    // Get the link from the original message
    const originalText = ctx.callbackQuery.message.reply_to_message?.text;
    const urlMatch = originalText?.match(URL_REGEX);
    
    if (!urlMatch) return ctx.answerCbQuery("❌ Link expired or not found.");
    const url = urlMatch[0];

    await ctx.answerCbQuery("🚀 Processing...");
    await ctx.editMessageText(`⏳ *Downloading ${quality === 'mp3' ? 'Audio' : quality + 'p'}...*`, { parse_mode: 'Markdown' });

    const timestamp = Date.now();
    const basePath = path.join(downloadDir, `${timestamp}`);
    let finalFile;

    try {
        if (type === 'audio') {
            finalFile = `${basePath}.mp3`;
            await runYtDlp(`-x --audio-format mp3 -o "${basePath}.%(ext)s" "${url}"`);
        } else {
            finalFile = `${basePath}.mp4`;
            // Download video+bestaudio and merge
            await runYtDlp(`-f ${id}+bestaudio/best -S vcodec:h264 --merge-output-format mp4 -o "${basePath}.%(ext)s" "${url}"`);
        }

        // Check Size limit (50MB Telegram Limit)
        const stats = fs.statSync(finalFile);
        if (stats.size > 49 * 1024 * 1024) {
            await ctx.editMessageText("⚠️ File is too big (>50MB). Telegram API won't allow me to upload it.");
        } else {
            await ctx.editMessageText("📤 *Uploading to Telegram...*", { parse_mode: 'Markdown' });
            if (type === 'audio') {
                await ctx.replyWithAudio({ source: finalFile }, { caption: '🎵 Audio extracted via Bot' });
            } else {
                await ctx.replyWithVideo({ source: finalFile }, { caption: `🎥 ${quality}p video` });
            }
            await ctx.deleteMessage(); // Delete status message
        }
    } catch (e) {
        console.error(e);
        await ctx.editMessageText("❌ Error during download/upload.");
    } finally {
        // Cleanup file
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
    }
});

// --- SERVER SETUP ---
if (process.env.NODE_ENV === 'production') {
    // Render Webhook
    bot.launch({
        webhook: {
            domain: URL,
            port: PORT
        }
    }).then(() => console.log(`🚀 Webhook started on ${URL}`));
} else {
    bot.launch();
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
