require('dotenv').config();
const path = require('path');

module.exports = {
    // API Keys
    BOT_TOKEN: process.env.BOT_TOKEN,
    APP_URL: process.env.RENDER_EXTERNAL_URL,
    PORT: process.env.PORT || 3000,
    
    // Paths
    DOWNLOAD_DIR: path.join(__dirname, '../../downloads'),
    COOKIE_PATH: path.join(__dirname, '../../cookies.txt'),
    DB_PATH: path.join(__dirname, '../../database.json'), // NEW: Database File
    
    // Identity
    UA_ANDROID: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    
    // Regex (Updated for Spotify & SoundCloud)
    URL_REGEX: /(https?:\/\/(?:www\.|old\.|mobile\.|m\.)?(?:reddit\.com|redd\.it|x\.com|twitter\.com|instagram\.com|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|spotify\.com|soundcloud\.com)\/[^\s]+)/i,
    
    // Reddit Mirrors
    REDDIT_MIRRORS: [
        'https://redlib.catsarch.com',
        'https://redlib.vlingit.com',
        'https://libreddit.kavin.rocks',
        'https://redlib.tux.pizza',
        'https://redlib.ducks.party',
        'https://r.walkx.org'
    ]
};