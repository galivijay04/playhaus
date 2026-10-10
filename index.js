require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());

// ─── Serve uploaded banners publicly (ngrok tunnels port 3000) ───────────────
app.use("/uploads", express.static(path.join(__dirname, "admin", "uploads")));

const { ACCESS_TOKEN, PHONE_NUMBER_ID, WEBHOOK_VERIFY_TOKEN, PORT = 3000 } = process.env;
const GRAPH_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
const CONFIG_PATH   = path.join(__dirname, "config.json");
const FLOW_PATH     = path.join(__dirname, "flow.json");
const FLOW_ID       = "1090157514003637";

// ─── Always read fresh config ─────────────────────────────────────────────────
function getConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ─── Rebuild flow.json from config products (keeps flow in sync with admin) ──
function rebuildFlow() {
  const cfg      = getConfig();
  const products = (cfg.products || []).filter((p) => p.active);

  const dataSource = products.map((p) => ({
    "id":          p.flowId || p.id,
    "title":       p.name,
    "description": `${p.price} • ${p.tags || ""}`,
    "image-url":   p.imageUrl || ""
  }));

  const flow = {
    version: "7.3",
    screens: [
      {
        id: "CHOOSE_SERVICE",
        title: "Playhaus Services",
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Welcome to Playhaus 🎮" },
            { type: "TextBody",    text: "Please select the service you need." },
            {
              type: "RadioButtonsGroup",
              name: "service",
              label: "Select Service",
              required: true,
              "data-source": [
                { id: "place_order",     title: "Place Order"      },
                { id: "track_order",     title: "Track Order"      },
                { id: "customer_support",title: "Customer Support" }
              ]
            },
            {
              type: "Footer",
              label: "Continue",
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: "CHOOSE_PRODUCT" },
                payload: { service: "${form.service}" }
              }
            }
          ]
        }
      },
      {
        id: "CHOOSE_PRODUCT",
        title: "Our Games",
        terminal: true,
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Select a Product 🛍️" },
            { type: "TextBody",    text: "Tap a game below to place your order." },
            {
              type: "RadioButtonsGroup",
              name: "product",
              label: "Our Games",
              required: true,
              "data-source": dataSource
            },
            {
              type: "Footer",
              label: "Place Order",
              "on-click-action": {
                name: "complete",
                payload: {
                  service: "${data.service}",
                  product: "${form.product}"
                }
              }
            }
          ]
        }
      }
    ]
  };

  fs.writeFileSync(FLOW_PATH, JSON.stringify(flow, null, 2), "utf8");
  return flow;
}

// ─── Send plain text ──────────────────────────────────────────────────────────
async function sendText(to, text) {
  await axios.post(
    GRAPH_API_URL,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// ─── Send a product card (image + details) ───────────────────────────────────
async function sendProductCard(to, product) {
  const caption =
    `🎮 *${product.name}*\n` +
    `💰 ${product.price}\n\n` +
    `${product.description}\n\n` +
    `🔗 ${product.productUrl}`;

  if (product.imageUrl) {
    await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: { link: product.imageUrl, caption },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
  } else {
    await sendText(to, caption);
  }
}

// ─── Welcome + Flow as ONE combined interactive message ───────────────────────
async function sendWelcomeWithFlow(to) {
  const cfg = getConfig();

  const fullBody =
    `${cfg.welcomeMessage || "Welcome to *PlayHaus: Kheloge Toh Khiloge* 🎉"}\n\n` +
    `${cfg.flowBodyText   || "What would you like to do today?"}`;

  const header = cfg.welcomeBannerUrl
    ? { type: "image", image: { link: cfg.welcomeBannerUrl } }
    : { type: "text",  text:  "🎮 Playhaus" };

  await axios.post(
    GRAPH_API_URL,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type:   "flow",
        header,
        body:   { text: fullBody },
        footer: { text: cfg.flowFooterText || "Kheloge Toh Khiloge ✨" },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token:           `flow-${to}-${Date.now()}`,
            flow_id:              FLOW_ID,
            flow_cta:             cfg.flowCtaText || "Choose a Service",
            flow_action:          "navigate",
          },
        },
      },
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// ─── Handle flow response ─────────────────────────────────────────────────────
async function handleFlowResponse(sender, responseData) {
  const service     = responseData?.service;
  const productId   = responseData?.product;
  const productName = responseData?.product_name;
  const unitPrice   = responseData?.unit_price   || "999";
  const quantity    = responseData?.quantity      || "1";
  const specialNote = responseData?.special_note  || "";

  console.log(`🎯 Service: ${service} | Product: ${productId} | Qty: ${quantity}`);

  // ── Place Order ────────────────────────────────────────────────────────────
  if (service === "place_order" && productId) {
    const cfg   = getConfig();
    const found = cfg.products.find(
      (p) => (p.flowId === productId || p.id === productId) && p.active
    );

    const name  = found?.name  || productName || productId;
    const price = parseInt(unitPrice) || 999;
    const qty   = parseInt(quantity)  || 1;
    const total = price * qty;

    await sendText(
      sender,
      `🎉 *Order Received!*\n\n` +
      `🎮 *${name}*\n` +
      `💰 Rs.${price} × ${qty} = *Rs.${total}*\n` +
      (specialNote ? `📝 Note: ${specialNote}\n` : ``) +
      `\n✅ Your order has been placed!\n\n` +
      `Our team will contact you shortly to confirm delivery.\n\n` +
      `📞 +91 6364936004\n📧 care@playhaus.in`
    );

    if (found) {
      await new Promise((r) => setTimeout(r, 700));
      await sendProductCard(sender, found);
    }
    return;
  }

  // ── Track Order ────────────────────────────────────────────────────────────
  if (service === "track_order") {
    await sendText(
      sender,
      `📦 *Track Your Order*\n\nPlease share:\n• Your Order ID\n• Registered mobile number\n\nOur team will update you within 24 hours. ⏰`
    );
    return;
  }

  // ── Customer Support ───────────────────────────────────────────────────────
  if (service === "customer_support") {
    await sendText(
      sender,
      `🎧 *Customer Support*\n\nWe're here to help! 😊\n\n📞 +91 6364936004\n📧 care@playhaus.in\n🕐 Mon–Sat, 10am–6pm\n\nOr just reply with your issue and we'll get back to you!`
    );
    return;
  }

  await sendText(sender, `✅ Got your selection! Our team will reach out shortly. 🙌`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta.");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (
      !body?.object ||
      body.object !== "whatsapp_business_account" ||
      !body.entry?.[0]?.changes?.[0]?.value
    ) return;

    const messages = body.entry[0].changes[0].value.messages;
    if (!messages?.length) return;

    const msg    = messages[0];
    const sender = msg.from;
    const type   = msg.type;
    console.log(`\n📨 Message from ${sender} | type: ${type}`);

    // ── Flow completed ────────────────────────────────────────────────────
    if (type === "interactive" && msg.interactive?.type === "nfm_reply") {
      const raw = msg.interactive.nfm_reply;
      console.log("📋 Flow response:", JSON.stringify(raw));
      let data = raw;
      if (raw.response_json) {
        try { data = JSON.parse(raw.response_json); } catch (_) {}
      }
      await handleFlowResponse(sender, data);
      return;
    }

    // ── Any other message → welcome + flow ───────────────────────────────
    await sendWelcomeWithFlow(sender);

  } catch (err) {
    console.error("❌ Error:", JSON.stringify(err?.response?.data || err.message, null, 2));
    console.error("❌ Stack:", err.stack);
  }
});

// ─── Endpoint to get current flow JSON (admin panel copy-paste) ──────────────
app.get("/flow.json", (req, res) => {
  try {
    const flow = JSON.parse(fs.readFileSync(FLOW_PATH, "utf8"));
    res.json(flow);
  } catch (e) {
    res.status(500).json({ error: "flow.json not found. Run generate-flow.js first." });
  }
});

app.get("/", (req, res) => res.send("WhatsApp bot is running 🟢"));

app.listen(PORT, () => {
  console.log(`🚀 Bot server started on port ${PORT}`);
});
