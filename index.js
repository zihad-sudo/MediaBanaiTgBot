const http = require("http");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const ytDlp = require("yt-dlp-exec");
const ffmpegPath = require("ffmpeg-static");
const FormData = require("form-data");

const TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

// --- HELPER FUNCTIONS ---

// Send text message
async function sendMessage(chatId, text) {
    try {
        await fetch(`${API}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text })
        });
    } catch (e) {
        console.error("Error sending message:", e);
    }
}

// Send file to Telegram
async function sendDocument(chatId, filePath) {
    try {
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("document", fs.createReadStream(filePath));

        await fetch(`${API}/sendDocument`, {
            method: "POST",
            body: form
        });
    } catch (e) {
        console.error("Error sending document:", e);
        throw e; // Pass error up
    }
}

// --- SERVER & BOT LOGIC ---

const server = http.createServer(async (req, res) => {
    if (req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            try {
                const update = JSON.parse(body);
                if (update.message) {
                    const chatId = update.message.chat.id;
                    const text = update.message.text;

                    if (text === "/start") {
                        await sendMessage(chatId, "👋 Ready! Send me a link.");
                    } else if (text === "/help") {
                        await sendMessage(chatId, "Simply send a link (Reddit, Twitter, etc) to download.");
                    } else if (text && text.startsWith("http")) {
                        // Automatically detect links without needing /download command
                        const url = text.trim();
                        
                        await sendMessage(chatId, "⏳ Downloading...");

                        const tmpFile = path.join("/tmp", `media_${Date.now()}.mp4`);

                        try {
                            console.log(`Processing: ${url}`);

                            await ytDlp(url, {
                                output: tmpFile,
                                ffmpegLocation: ffmpegPath,
                                
                                // 1. FORCE IPv4: Cloud servers often have bad IPv6 reputation
                                forceIpv4: true,

                                // 2. BROWSER HEADERS: Mimic a real Chrome user on Windows
                                addHeader: [
                                    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                                    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                                    "Accept-Language: en-US,en;q=0.5",
                                    "Sec-Fetch-Mode: navigate",
                                    "Referer: https://www.google.com/"
                                ],

                                // 3. SETTINGS: lenient settings to prevent crashes
                                noCheckCertificates: true,
                                preferFreeFormats: true,
                                ignoreErrors: true, // Don't crash on minor warnings
                                format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
                            });

                            // Check if file exists and has size
                            if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
                                await sendMessage(chatId, "✅ Uploading to Telegram...");
                                await sendDocument(chatId, tmpFile);
                                fs.unlink(tmpFile, () => {}); // Cleanup
                            } else {
                                await sendMessage(chatId, "❌ Download failed. The server IP is strictly blocked by this site.");
                            }

                        } catch (err) {
                            console.error("YT-DLP Error:", err);
                            await sendMessage(chatId, `❌ Error: ${err.message}`);
                        }
                    }
                }
            } catch (e) {
                console.error("General Error:", e);
            }
            res.writeHead(200);
            res.end("OK");
        });
    } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Bot is alive");
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bot server running on port ${PORT}`);
});
