import os
import asyncio
from datetime import datetime
from collections import deque
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.functions.messages import SendReactionRequest
from telethon.tl.types import ReactionEmoji
from aiohttp import web

# ==========================================
# 1. CONFIG & CREDENTIALS
# ==========================================
API_ID = int(os.environ.get('API_ID', '38622204'))
API_HASH = os.environ.get('API_HASH', 'd1da3bccca8184f39121e020c9b9dd44')
SESSION_STRING = os.environ.get('SESSION_STRING')

DEFAULT_DESTINATION = 'UsBabyUs'

# Store last 100 log lines
LOG_BUFFER = deque(maxlen=100)

print("Starting Cloud Bot with Web Terminal...")

try:
    client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)
except Exception as e:
    print(f"Error initializing client: {e}")
    exit()

# ==========================================
# 2. LOGGING SYSTEM
# ==========================================
def log(message, type="info"):
    print(f"[{type.upper()}] {message}")
    timestamp = datetime.now().strftime("%H:%M:%S")
    css_class = "log-info"
    if type == "success": css_class = "log-success"
    elif type == "error": css_class = "log-error"
    elif type == "system": css_class = "log-system"

    entry = {
        "time": timestamp,
        "msg": message,
        "class": css_class
    }
    LOG_BUFFER.append(entry)

# ==========================================
# 3. WEB SERVER (FIXED TEMPLATE)
# ==========================================
# Notice: All CSS brackets { } are now double {{ }} to prevent crash
HTML_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
    <title>Bot Terminal</title>
    <meta http-equiv="refresh" content="3">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {{ background-color: #0c0c0c; color: #cccccc; font-family: 'Consolas', 'Monaco', monospace; margin: 0; padding: 20px; font-size: 14px; }}
        .container {{ max-width: 800px; margin: 0 auto; }}
        .header {{ border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 10px; color: #888; }}
        .log-entry {{ margin-bottom: 4px; border-left: 2px solid transparent; padding-left: 8px; }}
        .time {{ color: #666; margin-right: 10px; }}
        
        .log-info {{ color: #cccccc; }}
        .log-success {{ color: #00ff00; border-left-color: #00ff00; }}
        .log-error {{ color: #ff3333; border-left-color: #ff3333; }}
        .log-system {{ color: #00ccff; border-left-color: #00ccff; }}
        
        .cursor {{ display: inline-block; width: 8px; height: 15px; background: #00ff00; animation: blink 1s infinite; }}
        @keyframes blink {{ 50% {{ opacity: 0; }} }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            SYSTEM ONLINE | MONITORING ACTIVE<br>
            Server Time: {server_time}
        </div>
        <div class="logs">
            {log_rows}
        </div>
        <div class="log-entry">
            <span class="time">>></span> <span class="cursor"></span>
        </div>
    </div>
</body>
</html>
"""

async def handle_website(request):
    rows_html = ""
    for entry in LOG_BUFFER:
        rows_html += f'<div class="log-entry {entry["class"]}"><span class="time">[{entry["time"]}]</span>{entry["msg"]}</div>'
    
    # We use format() to inject the Python variables
    full_html = HTML_TEMPLATE.format(
        server_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        log_rows=rows_html
    )
    return web.Response(text=full_html, content_type='text/html')

async def start_server():
    app = web.Application()
    app.router.add_get('/', handle_website)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 8080))
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    log(f"Web Terminal launched on port {port}", "system")

# ==========================================
# 4. BOT LOGIC
# ==========================================
@client.on(events.NewMessage(pattern='(?i)^/fr'))
async def handler(event):
    if not event.out or not event.is_reply: return

    try:
        original_msg = await event.get_reply_message()
        target = DEFAULT_DESTINATION
        parts = event.text.split()
        
        if len(parts) > 1 and parts[1].startswith('@'):
            target = parts[1]

        log(f"Processing Request -> {target}", "info")

        await client.send_message(target, original_msg)

        try:
            await client(SendReactionRequest(
                peer=event.chat_id,
                msg_id=original_msg.id,
                reaction=[ReactionEmoji(emoticon='⚡')] 
            ))
            reaction_msg = " + Reacted"
        except:
            reaction_msg = ""

        log(f"Successfully forwarded to {target}{reaction_msg}", "success")
        await event.delete()

    except Exception as e:
        log(f"Failed: {str(e)}", "error")

# ==========================================
# 5. STARTUP
# ==========================================
async def main():
    await client.start()
    log("Telegram Client Connected", "system")
    await start_server()
    log("Bot is ready and listening...", "system")
    await client.run_until_disconnected()

if __name__ == '__main__':
    loop = asyncio.get_event_loop()
    loop.run_until_complete(main())