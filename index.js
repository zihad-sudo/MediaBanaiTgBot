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
const URL = process.env.RENDER_EXTERNAL_URL; 
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
    console.error("❌ BOT_TOKEN is missing!");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

const URL_REGEX = /(https?:\/\/(?:www\.|old\.|mobile\.)?(?:reddit\.com|x\.com|twitter\.com)\/[^\s]+)/i;

// --- UTILITIES ---

const formatBytes = (bytes, decimals = 2) => {
    if (!+bytes) return 'Unknown';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
};

// HELPER: Resolve Reddit short links (fix for 403 errors)
const resolveRedirect = async (shortUrl) => {
    if (!shortUrl.includes('reddit.com') && !shortUrl.includes('/s/')) return shortUrl;
    
    return new Promise((resolve) => {
        https.get(shortUrl, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // If it's a redirect, return the new long URL
                resolve(res.headers.location);
            } else {
                // If no redirect, return original
                resolve(shortUrl);
            }
        }).on('error', () => resolve(shortUrl)); // Fallback to original on error
    });
};

const runYtDlp = async (args) => {
    // 1. Force IPv4 (often bypasses blocks)
    // 2. Add fake headers to look like a real PC
    // 3. Add Referer
    const headers = [
        '--add-header "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"',
        '--add-header "Referer:https://www.google.com/"',
        '--add-header "Accept-Language:en-US,en;q=0.9"'
    ].join(' ');

    const cmd = `yt-dlp --force-ipv4 --no-warnings --no-playlist ${headers} ${args}`;
    const { stdout } = await execPromise(cmd);
    return stdout;
};

// --- HANDLERS ---

bot.start((ctx) => ctx.reply("👋 Media Bot Ready! Send a Reddit or Twitter link."));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(URL_REGEX);
    if (!match) return; 

    const msg = await ctx.reply("🔍 *Processing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        let url = match[0];

        // FIX: Resolve Reddit short links to full links
        if (url.includes('reddit.com') && url.includes('/s/')) {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "🔗 *Resolving link...*", { parse_mode: 'Markdown' });
            url = await resolveRedirect(url);
        }

        // Fetch JSON
        const jsonOutput = await runYtDlp(`-J "${url}"`);
        const info = JSON.parse(jsonOutput);

        const formats = (info.formats || []).filter(f => f.ext === 'mp4' && f.height);
        
        // Logic to deduplicate qualities
        const uniqueQualities = [];
        const seenHeights = new Set();
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

        const buttons = [];
        uniqueQualities.slice(0, 5).forEach(q => {
            const size = formatBytes(q.filesize);
            buttons.push([Markup.button.callback(`📹 ${q.height}p (${size})`, `v|${q.id}|${q.height}`)]);
        });
        buttons.push([Markup.button.callback("🎵 Audio (MP3)", "a|mp3")]);

        // We store the CLEAN resolved URL in the text body (hidden char) or rely on reply
        // Hack: Append the URL at the bottom of the message text invisibly or visibly so we can grab it later
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            msg.message_id,
            null,
            `✅ Found: *${info.title.substring(0, 40)}...*\nChoose quality:\n\nUrlSource: ${url}`, 
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (err) {
        console.error(err);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Reddit might be blocking the server, or the link is private.");
    }
});

bot.on('callback_query', async (ctx) => {
    const [type, id, quality] = ctx.callbackQuery.data.split('|');
    
    // Retrieve URL from the message text we sent earlier
    // We look for "UrlSource: http..."
    const messageText = ctx.callbackQuery.message.text;
    const urlMatch = messageText.match(/UrlSource: (https?:\/\/[^\s]+)/);
    
    let url = "";
    if (urlMatch) {
        url = urlMatch[1];
    } else {
        // Fallback to original reply method if parsing fails
        const replyText = ctx.callbackQuery.message.reply_to_message?.text;
        const replyMatch = replyText?.match(URL_REGEX);
        if (replyMatch) url = replyMatch[0];
    }

    if (!url) return ctx.answerCbQuery("❌ Link lost. Resend.");

    await ctx.answerCbQuery("🚀 Downloading...");
    await ctx.editMessageText(`⏳ *Downloading ${quality}...*`, { parse_mode: 'Markdown' });

    const timestamp = Date.now();
    const basePath = path.join(downloadDir, `${timestamp}`);
    let finalFile;

    try {
        if (type === 'a') {
            finalFile = `${basePath}.mp3`;
            await runYtDlp(`-x --audio-format mp3 -o "${basePath}.%(ext)s" "${url}"`);
        } else {
            finalFile = `${basePath}.mp4`;
            await runYtDlp(`-f ${id}+bestaudio/best -S vcodec:h264 --merge-output-format mp4 -o "${basePath}.%(ext)s" "${url}"`);
        }

        const stats = fs.statSync(finalFile);
        if (stats.size > 49 * 1024 * 1024) {
            await ctx.editMessageText("⚠️ File > 50MB. Cannot upload.");
        } else {
            await ctx.editMessageText("📤 *Uploading...*", { parse_mode: 'Markdown' });
            if (type === 'a') {
                await ctx.replyWithAudio({ source: finalFile }, { caption: '🎵 Audio' });
            } else {
                await ctx.replyWithVideo({ source: finalFile }, { caption: `🎥 ${quality}p` });
            }
            await ctx.deleteMessage(); 
        }
    } catch (e) {
        console.error(e);
        await ctx.editMessageText("❌ Download failed.");
    } finally {
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
    }
});

if (process.env.NODE_ENV === 'production') {
    bot.launch({ webhook: { domain: URL, port: PORT } }).then(() => console.log(`🚀 Webhook: ${URL}`));
} else {
    bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
