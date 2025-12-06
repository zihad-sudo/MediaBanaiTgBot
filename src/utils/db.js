const mongoose = require('mongoose');
const config = require('../config/settings');

// 1. Define Schemas
const UserSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    joinedAt: { type: Date, default: Date.now }
});

const StatSchema = new mongoose.Schema({
    key: { type: String, unique: true }, // 'global'
    downloads: { type: Number, default: 0 }
});

// 2. Create Models
const User = mongoose.model('User', UserSchema);
const Stat = mongoose.model('Stat', StatSchema);

// 3. Database Functions
const connect = async () => {
    if (!config.MONGO_URI) {
        console.error("❌ MONGO_URI is missing in Environment Variables!");
        return;
    }
    try {
        await mongoose.connect(config.MONGO_URI);
        console.log("✅ Connected to MongoDB");
        // Initialize Global Stats if not exists
        const exists = await Stat.findOne({ key: 'global' });
        if (!exists) await Stat.create({ key: 'global', downloads: 0 });
    } catch (e) {
        console.error("❌ MongoDB Connection Error:", e.message);
    }
};

const addUser = async (userId) => {
    try {
        const exists = await User.findOne({ id: String(userId) });
        if (!exists) {
            await User.create({ id: String(userId) });
            console.log(`🆕 New User Registered: ${userId}`);
        }
    } catch (e) {}
};

const incrementDownloads = async () => {
    try {
        await Stat.updateOne({ key: 'global' }, { $inc: { downloads: 1 } });
    } catch (e) { console.error("DB Error:", e.message); }
};

const getStats = async () => {
    try {
        const userCount = await User.countDocuments();
        const stat = await Stat.findOne({ key: 'global' });
        return {
            users: userCount,
            downloads: stat ? stat.downloads : 0
        };
    } catch (e) {
        return { users: 0, downloads: 0 };
    }
};

const getAllUsers = async () => {
    try {
        const users = await User.find({}, 'id');
        return users.map(u => u.id);
    } catch (e) { return []; }
};

module.exports = { connect, addUser, incrementDownloads, getStats, getAllUsers };