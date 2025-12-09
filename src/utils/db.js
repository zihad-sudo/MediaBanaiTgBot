const mongoose = require('mongoose');
const config = require('../config/settings');

// 1. Updated User Schema
const UserSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    username: { type: String },
    firstName: { type: String },
    downloads: { type: Number, default: 0 },
    joinedAt: { type: Date, default: Date.now },
    
    // ✅ NEW: Twitter API Config
    twitterConfig: {
        mode: { type: String, default: 'webhook' }, // 'webhook' OR 'api'
        apiKey: { type: String, default: '' },
        targetHandle: { type: String, default: '' },
        lastLikedId: { type: String, default: '0' } // Tracks the last post we saw
    }
});

const StatSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    downloads: { type: Number, default: 0 }
});

const NicknameSchema = new mongoose.Schema({
    name: { type: String, required: true },
    targetId: { type: String, required: true },
    groupId: { type: String, required: true }
});
NicknameSchema.index({ name: 1, groupId: 1 }, { unique: true });

const User = mongoose.model('User', UserSchema);
const Stat = mongoose.model('Stat', StatSchema);
const Nickname = mongoose.model('Nickname', NicknameSchema);

const connect = async () => {
    if (!config.MONGO_URI) return console.error("❌ MONGO_URI missing!");
    try {
        await mongoose.connect(config.MONGO_URI);
        console.log("✅ Connected to MongoDB");
        const exists = await Stat.findOne({ key: 'global' });
        if (!exists) await Stat.create({ key: 'global', downloads: 0 });
    } catch (e) { console.error("❌ DB Error:", e.message); }
};

const addUser = async (ctx) => {
    if (!ctx.from) return;
    try {
        const userId = String(ctx.from.id);
        const username = ctx.from.username ? `@${ctx.from.username}` : 'No Username';
        const firstName = ctx.from.first_name || 'User';
        await User.findOneAndUpdate({ id: userId }, { username, firstName }, { upsert: true, new: true });
    } catch (e) {}
};

// ✅ NEW CONFIG FUNCTIONS
const getAdminConfig = async (adminId) => {
    return await User.findOne({ id: String(adminId) });
};

const updateApiConfig = async (adminId, apiKey, handle) => {
    // Reset lastLikedId to 0 when setting up new API to trigger "First Run" logic
    return await User.findOneAndUpdate(
        { id: String(adminId) },
        { 
            'twitterConfig.apiKey': apiKey,
            'twitterConfig.targetHandle': handle,
            'twitterConfig.mode': 'api',
            'twitterConfig.lastLikedId': '0' 
        },
        { new: true }
    );
};

const updateLastId = async (adminId, tweetId) => {
    await User.updateOne({ id: String(adminId) }, { 'twitterConfig.lastLikedId': tweetId });
};

const toggleMode = async (adminId, mode) => {
    await User.updateOne({ id: String(adminId) }, { 'twitterConfig.mode': mode });
};

const incrementDownloads = async (userId) => {
    try { 
        await Stat.updateOne({ key: 'global' }, { $inc: { downloads: 1 } });
        if (userId) await User.updateOne({ id: String(userId) }, { $inc: { downloads: 1 } });
    } catch (e) {}
};

const getDetailedStats = async () => {
    try {
        const userCount = await User.countDocuments();
        const globalStat = await Stat.findOne({ key: 'global' });
        const topUsers = await User.find().sort({ downloads: -1 }).limit(20);
        return { totalUsers: userCount, totalDownloads: globalStat ? globalStat.downloads : 0, userList: topUsers };
    } catch (e) { return null; }
};

const getAllUsers = async () => {
    try {
        const users = await User.find({}, 'id');
        return users.map(u => u.id);
    } catch (e) { return []; }
};

const setNickname = async (groupId, name, targetId) => {
    await Nickname.findOneAndUpdate({ name: name.toLowerCase(), groupId: String(groupId) }, { targetId: String(targetId) }, { upsert: true, new: true });
};
const getNickname = async (groupId, name) => { return await Nickname.findOne({ name: name.toLowerCase(), groupId: String(groupId) }); };
const deleteNickname = async (groupId, name) => { return await Nickname.deleteOne({ name: name.toLowerCase(), groupId: String(groupId) }); };

module.exports = { 
    connect, addUser, incrementDownloads, getDetailedStats, getAllUsers, 
    setNickname, getNickname, deleteNickname,
    getAdminConfig, updateApiConfig, updateLastId, toggleMode 
};