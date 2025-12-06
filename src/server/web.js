const express = require('express');
const config = require('../config/settings');
const logger = require('../utils/logger');
const { version } = require('../../package.json');

const start = (bot) => {
    const app = express();

    app.get('/api/logs', (req, res) => res.json(logger.getLogs()));

    app.get('/', (req, res) => {
        res.send(`
        <html>
        <head>
            <meta http-equiv="refresh" content="2">
            <title>Media Banai v${version}</title>
            <style>body{background:#0d1117;color:#c9d1d9;font-family:monospace;padding:20px} .err{color:#f85149} .inf{color:#3fb950}</style>
        </head>
        <body>
            <h1>🚀 Media Banai Bot v${version}</h1>
            <div id="logs">Loading...</div>
            <script>
                fetch('/api/logs').then(r=>r.json()).then(d=>{
                    document.getElementById('logs').innerHTML = d.map(l => 
                        \`<div style="border-bottom:1px solid #30363d;padding:2px">
                            <span style="color:#8b949e">[\${l.time}]</span> 
                            <span class="\${l.type === 'ERROR' ? 'err' : 'inf'}">\${l.type}</span> 
                            \${l.message}
                        </div>\`
                    ).join('');
                });
            </script>
        </body>
        </html>`);
    });

    if (process.env.NODE_ENV === 'production') {
        app.use(bot.webhookCallback('/bot'));
        bot.telegram.setWebhook(`${config.APP_URL}/bot`);
        app.listen(config.PORT, '0.0.0.0', () => console.log(`🚀 Server on ${config.PORT}`));
    } else {
        bot.launch();
        console.log("🚀 Bot started");
    }
};

module.exports = { start };