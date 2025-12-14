from telethon.sync import TelegramClient
from telethon.sessions import StringSession

# YOUR CREDENTIALS
api_id = 38622204
api_hash = 'd1da3bccca8184f39121e020c9b9dd44'

print("--- TELEGRAM SESSION GENERATOR ---")
print("Logging in...")

with TelegramClient(StringSession(), api_id, api_hash) as client:
    session_string = client.session.save()
    print("\n✅ LOGIN SUCCESSFUL!")
    print("\n👇 COPY THIS LONG CODE BELOW (ALL OF IT) 👇\n")
    print(session_string)
    print("\n👆 COPY THE CODE ABOVE 👆")
    print("Do not share this code with anyone else!")