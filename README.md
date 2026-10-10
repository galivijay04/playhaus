# WhatsApp Bot — Meta Cloud API

Automated WhatsApp flow:

```
User sends any message
       ↓
Bot replies: Welcome + [✅ Yes] [❌ No] buttons
       ↓
User taps Yes  →  "Have a nice day!"
User taps No   →  "Come back again!"
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A public HTTPS URL for your webhook (use [ngrok](https://ngrok.com/) for local dev)

---

## Setup

### 1. Install dependencies

```bash
cd whatsapp-bot
npm install
```

### 2. Configure environment

Edit `.env` — your credentials are already filled in. The only value you **must**
change before registering with Meta is `WEBHOOK_VERIFY_TOKEN`. Pick any secret string.

### 3. Expose your local server (development)

Install ngrok and run:

```bash
ngrok http 3000
```

Copy the `https://xxxx.ngrok.io` URL — you'll paste it into the Meta dashboard.

### 4. Register the webhook in Meta

1. Go to [Meta for Developers](https://developers.facebook.com/) → your app → **WhatsApp → Configuration**
2. **Callback URL**: `https://xxxx.ngrok.io/webhook`
3. **Verify token**: same string you set in `.env` as `WEBHOOK_VERIFY_TOKEN`
4. Click **Verify and Save**
5. Under **Webhook fields**, subscribe to **messages**

### 5. Start the bot

```bash
npm start
# or for auto-reload during development:
npm run dev
```

---

## Message Flow

| Event | Bot action |
|---|---|
| User sends any message (first time or text) | Send welcome + Yes/No buttons |
| User taps **Yes** | Reply "Have a nice day!" |
| User taps **No** | Reply "Come back again!" |
| User sends text while waiting for button tap | Re-send buttons |

---

## Production deployment

Deploy to any Node.js host (Railway, Render, Heroku, VPS, etc.) that gives you a
permanent HTTPS URL, then update the callback URL in the Meta dashboard.

> **Security note:** Never commit `.env` to source control. The `.gitignore`
> already excludes it.
