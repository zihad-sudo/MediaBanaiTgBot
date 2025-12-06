// File: src/server/web.js
const express = require('express');
const logger = require('../utils/logger');
const config = require('../config/settings');

const setupServer = (bot) => {
    const app = express();

    // 1. API Endpoint for Logs
    app.get('/api/logs', (req, res) => {
        res.json(logger.getLogs());
    });

    // 2. The "Hacker Terminal" Interface
    app.get('/', (req, res) => {
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Media Banai - Live Console</title>
            <style>
                body { background-color: #0d1117; color: #c9d1d9; font-family: 'Consolas', 'Courier New', monospace; padding: 20px; font-size: 13px; margin: 0; }
                h1 { color: #58a6ff; font-size: 18px; border-bottom: 1px solid #30363d; padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
                .status { font-size: 12px; background: #238636; color: white; padding: 2px 8px; border-radius: 12px; }
                #logs { white-space: pre-wrap; word-wrap: break-word; height: 85vh; overflow-y: auto; padding-bottom: 50px; }
                .log-entry { margin-bottom: 4px; display: flex; line-height: 1.5; border-bottom: 1px solid #161b22; }
                .timestamp { color: #8b949e; min-width: 90px; user-select: none; }
                .type-INFO { color: #3fb950; font-weight: bold; min-width: 50px; }
                .type-ERROR { color: #f85149; font-weight: bold; min-width: 50px; }
                .msg { color: #e6edf3; }
                .autoscroll { position: fixed; bottom: 20px; right: 20px; background: #1f6feb; color: white; border: none; padding: 10px 20px; border-radius: 20px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
            </style>
        </head>
        <body>
            <h1>
                <span>🚀 Media Banai Bot</span>
                <span class="status">● Online</span>
            </h1>
            <div id="logs">Connecting to log stream...</div>
            <button class="autoscroll" onclick="toggleScroll()" id="scrollBtn">Auto-Scroll: ON</button>
            <script>
                let autoScroll = true;
                const logContainer = document.getElementById('logs');
                const btn = document.getElementById('scrollBtn');
                function toggleScroll() {
                    autoScroll = !autoScroll;
                    btn.style.background = autoScroll ? '#1f6feb' : '#30363d';
                    btn.innerText = 'Auto-Scroll: ' + (autoScroll ? 'ON' : 'OFF');
                }
                async function fetchLogs() {
                    try {
                        const res = await fetch('/api/logs');
                        const data = await res.json();
                        logContainer.innerHTML = data.map(log => 
                            \`<div class="log-entry">
                                <span class="timestamp">[\${log.time}]</span>
                                <span class="type-\${log.type}">\${log.type}</span>
                                <span class="msg">\${log.message}</span>
                            </div>\`
                        ).join('');
                        if (autoScroll) window.scrollTo(0, document.body.scrollHeight);
                    } catch (e) { console.error("Log fetch failed", e); }
                }
                setInterval(fetchLogs, 2000);
                fetchLogs();
            </script>
        </body>
        </html>
        `);
    });

    // Launch Server logic
    if (process.env.NODE_ENV === 'production') {
        app.use(bot.webhookCallback('/bot'));
        bot.telegram.setWebhook(`${config.APP_URL}/bot`);
        app.listen(config.PORT, '0.0.0.0', () => console.log(`🚀 Server listening on port ${config.PORT}`));
    } else {
        bot.launch();
        console.log("🚀 Polling mode started");
    }
};

module.exports = { setupServer };