const { Markup } = require('telegraf');
const config = require('../config/settings');
const extractor = require('../services/extractors');
const { resolveRedirect } = require('../utils/helpers');

const handleMessage = async (ctx) => {
    const match = ctx.message.text.match(config.URL_REGEX);
    if (!match) return;

    console.log(`📩 Request: ${match[0]}`);
    const msg = await ctx.reply("🔍 *Analyzing...*", { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });

    try {
        const fullUrl = await resolveRedirect(match[0]);
        const media = await extractor.extract(fullUrl);

        if (!media) throw new Error("Media not found");

        const buttons = [];
        let text = `✅ *${(media.title).substring(0, 50)}...*`;

        // 1. Gallery
        if (media.type === 'gallery') {
            text += `\n📚 **Album:** ${media.items.length} items`;
            buttons.push([Markup.button.callback(`📥 Download Album`, `alb|all`)]);
        } 
        // 2. Image
        else if (media.type === 'image') {
            buttons.push([Markup.button.callback(`🖼 Download Image`, `img|single`)]);
        } 
        // 3. Video
        else if (media.type === 'video') {
            // Qualities
            if (media.formats?.length > 0 && !fullUrl.includes('tiktok') && !fullUrl.includes('instagram')) {
                const formats = media.formats.filter(f => f.ext === 'mp4' && f.height).sort((a,b) => b.height - a.height).slice(0, 5);
                formats.forEach(f => {
                    if(!buttons.some(b => b[0].text.includes(f.height))) 
                        buttons.push([Markup.button.callback(`📹 ${f.height}p`, `vid|${f.format_id}`)]);
                });
            }
            if (buttons.length === 0) buttons.push([Markup.button.callback("📹 Download Video", `vid|best`)]);
            buttons.push([Markup.button.callback("🎵 Audio Only", "aud|best")]);
        }

        // Store Safe URL
        const safeUrl = (media.type === 'video' && media.url) ? media.url : (media.source || fullUrl);
        
        await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, null,
            `${text}\n[Source](${safeUrl})`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );

    } catch (e) {
        console.error(e);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Failed. Content unavailable.");
    }
};

module.exports = { handleMessage };