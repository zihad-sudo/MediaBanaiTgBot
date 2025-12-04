const http = require("http");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const ytDlp = require("yt-dlp-exec");
const ffmpegPath = require("ffmpeg-static");
const FormData = require("form-data");

const TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

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
        throw e;
    }
}

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
                        await sendMessage(chatId, "👋 Welcome! Send /help to see commands.");
                    } else if (text === "/help") {
                        await sendMessage(chatId, "Commands:\n/download <URL> - Download media\n/ping - Test bot");
                    } else if (text.startsWith("/ping")) {
                        await sendMessage(chatId, "🏓 Pong! Bot is alive.");
                    } else if (text.startsWith("/download ")) {
                        const url = text.replace("/download ", "").trim();
                        if (!url) {
                            await sendMessage(chatId, "❌ Please provide a URL.");
                        } else {
                            await sendMessage(chatId, "⏳ Processing download (Mobile Mode)...");

                            const tmpFile = path.join("/tmp", `media_${Date.now()}.mp4`);

                            try {
                                console.log(`Attempting download: ${url}`);
                                
                                await ytDlp(url, {
                                    output: tmpFile,
                                    ffmpegLocation: ffmpegPath,
                                    
                                    // SOLUTION: Impersonate the Reddit Android App
                                    // This bypasses the 403 Blocked error for browsers
                                    extractorArgs: "reddit:user_agent=android", 
                                    
                                    noCheckCertificates: true,
                                    preferFreeFormats: true,
                                    format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
                                });

                                if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
                                    await sendMessage(chatId, "✅ Download success! Uploading...");
                                    await sendDocument(chatId, tmpFile);
                                    fs.unlink(tmpFile, () => {});
                                } else {
                                    await sendMessage(chatId, "❌ Failed: File was not downloaded. The server IP might be completely banned.");
                                }

                            } catch (err) {
                                console.error("Error details:", err);
                                await sendMessage(chatId, `❌ Error: ${err.message}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Error parsing update:", e);
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
