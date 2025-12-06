const fs = require('fs');
const config = require('../config/settings');

// In-Memory Storage
const db = {
    users: new Set(),
    cache: new Map(), // Stores link -> file_id
    stats: {
        startTime: Date.now(),
        downloads: 0,
        cacheHits: 0
    }
};

// 1. Load data from disk on startup
if (fs.existsSync(config.DB_PATH)) {
    try {
        const raw = fs.readFileSync(config.DB_PATH, 'utf8');
        const data = JSON.parse(raw);
        
        if (data.users) db.users = new Set(data.users);
        if (data.cache) db.cache = new Map(data.cache); // JSON arrays -> Map
        if (data.stats) db.stats = { ...db.stats, ...data.stats };
        
        console.log(`📂 DB Loaded: ${db.users.size} users, ${db.cache.size} cached links.`);
    } catch (e) {
        console.error("DB Load Error:", e.message);
    }
}

// 2. Save data to disk
const save = () => {
    try {
        const data = {
            users: Array.from(db.users),
            cache: Array.from(db.cache.entries()), // Map -> Array for JSON
            stats: db.stats
        };
        fs.writeFileSync(config.DB_PATH, JSON.stringify(data));
    } catch (e) {
        console.error("DB Save Error:", e.message);
    }
};

// Auto-save every 2 minutes
setInterval(save, 2 * 60 * 1000);

module.exports = {
    // User Tracking
    addUser: (id) => db.users.add(id),
    getUserCount: () => db.users.size,

    // Caching Logic
    getCache: (url) => {
        // We clean the URL to ensure matches (remove tracking params)
        const clean = url.split('?')[0]; 
        return db.cache.get(clean);
    },
    setCache: (url, fileId, type) => {
        const clean = url.split('?')[0];
        // Limit cache size to prevent memory leaks (keep last 1000 items)
        if (db.cache.size > 1000) {
            const firstKey = db.cache.keys().next().value;
            db.cache.delete(firstKey);
        }
        db.cache.set(clean, { id: fileId, type });
    },

    // Stats
    addDownload: () => db.stats.downloads++,
    addCacheHit: () => db.stats.cacheHits++,
    getStats: () => db.stats
};