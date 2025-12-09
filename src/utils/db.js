const mongoose = require('mongoose');
const config = require('../config/settings');

// 1. Updated User Schema (Stores Username & Download Count)
const UserSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    username: { type: String }, // Stores @username
    firstName: { type: String },
    downloads: { type: Number, default: 0 }, // Individual count
    joinedAt: { type: Date, default: Date.now }
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

// --- Functions ---
const connect = async () => {
    if (!config.MONGO_URI) return console.error("❌ MONGO_URI missing!");
    try {
        await mongoose.connect(config.MONGO_URI);
        console.log("✅ Connected to MongoDB");
        const exists = await Stat.findOne({ key: 'global' });
        if (!exists) await Stat.create({ key: 'global', downloads: 0 });
    } catch (e) { console.error("❌ DB Error:", e.message); }
};

// Updated: Saves Username & Name now
const addUser = async (ctx) => {
    if (!ctx.from) return;
    try {
        const userId = String(ctx.from.id);
        const username = ctx.from.username ? `@${ctx.from.username}` : 'No Username';
        const firstName = ctx.from.first_name || 'User';

        // Update if exists, Create if new (Upsert)
        await User.findOneAndUpdate(
            { id: userId },
            { username: username, firstName: firstName },
            { upsert: true, new: true }
        );
    } catch (e) {}
};

// Updated: Increments BOTH Global and User stats
const incrementDownloads = async (userId) => {
    try { 
        // 1. Global
        await Stat.updateOne({ key: 'global' }, { $inc: { downloads: 1 } });
        // 2. User Specific
        if (userId) {
            await User.updateOne({ id: String(userId) }, { $inc: { downloads: 1 } });
        }
    } catch (e) {}
};

// Updated: Get Detailed Stats
const getDetailedStats = async () => {
    try {
        const userCount = await User.countDocuments();
        const globalStat = await Stat.findOne({ key: 'global' });
        
        // Get Top 20 Users by downloads
        const topUsers = await User.find().sort({ downloads: -1 }).limit(20);

        return {
            totalUsers: userCount,
            totalDownloads: globalStat ? globalStat.downloads : 0,
            userList: topUsers
        };
    } catch (e) { return null; }
};

const getAllUsers = async () => {
    try {
        const users = await User.find({}, 'id');
        return users.map(u => u.id);
    } catch (e) { return []; }
};

const setNickname = async (groupId, name, targetId) => {
    await Nickname.findOneAndUpdate(
        { name: name.toLowerCase(), groupId: String(groupId) },
        { targetId: String(targetId) },
        { upsert: true, new: true }
    );
};

const getNickname = async (groupId, name) => {
    return await Nickname.findOne({ name: name.toLowerCase(), groupId: String(groupId) });
};

const deleteNickname = async (groupId, name) => {
    return await Nickname.deleteOne({ name: name.toLowerCase(), groupId: String(groupId) });
};

module.exports = { connect, addUser, incrementDownloads, getDetailedStats, getAllUsers, setNickname, getNickname, deleteNickname };