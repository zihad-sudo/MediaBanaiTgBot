const config = require('../config/settings');
const db = require('./db');

const handleStats = async (ctx) => {
    // Security Check
    if (String(ctx.from.id) !== String(config.ADMIN_ID)) return;

    const stats = await db.getDetailedStats();
    if (!stats) return ctx.reply("❌ Error fetching stats.");

    // Format the User List
    // Format: "1. @username - 10 downloads"
    let userListText = "";
    stats.userList.forEach((u, index) => {
        const name = u.username !== 'No Username' ? u.username : u.firstName;
        userListText += `${index + 1}. <b>${name}</b>: ${u.downloads} DLs\n`;
    });

    const msg = `
📊 <b>Media Banai Statistics</b>

👥 <b>Total Users:</b> ${stats.totalUsers}
⬇️ <b>Total Downloads:</b> ${stats.totalDownloads}

🏆 <b>Top Active Users:</b>
${userListText || "No downloads yet."}
    `.trim();

    return ctx.reply(msg, { parse_mode: 'HTML' });
};

const handleBroadcast = async (ctx) => {
    if (String(ctx.from.id) !== String(config.ADMIN_ID)) return;

    const message = ctx.message.text.replace('/broadcast', '').trim();
    if (!message) return ctx.reply("⚠️ Usage: /broadcast [Your Message]");

    const users = await db.getAllUsers();
    let success = 0;
    let blocked = 0;

    await ctx.reply(`📢 Broadcasting to ${users.length} users...`);

    for (const userId of users) {
        try {
            await ctx.telegram.sendMessage(userId, `📢 <b>Admin Announcement</b>\n\n${message}`, { parse_mode: 'HTML' });
            success++;
            await new Promise(r => setTimeout(r, 50)); // Prevent spam limits
        } catch (e) {
            blocked++;
        }
    }

    return ctx.reply(`✅ Broadcast Complete.\n\nSent: ${success}\nFailed/Blocked: ${blocked}`);
};

module.exports = { handleStats, handleBroadcast };