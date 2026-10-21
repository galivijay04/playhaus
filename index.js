require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());

// ─── Serve uploaded banners publicly (ngrok tunnels port 3000) ───────────────
app.use("/uploads", express.static(path.join(__dirname, "admin", "uploads")));

const { ACCESS_TOKEN, PHONE_NUMBER_ID, WEBHOOK_VERIFY_TOKEN, PORT = 3000, CATALOG_ID = "2192111105021785" } = process.env;
const GRAPH_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
const CONFIG_PATH   = path.join(__dirname, "config.json");
const FLOW_PATH     = path.join(__dirname, "flow.json");
const FLOW_ID       = "1090157514003637";
const userCarts     = {};
const userOrders    = {};

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
  console.log(`📤 Sending welcome flow to ${to}...`);

  const fullBody =
    `${cfg.welcomeMessage || "Welcome to *PlayHaus: Kheloge Toh Khiloge* 🎉"}\n\n` +
    `${cfg.flowBodyText   || "What would you like to do today?"}`;

  const header = cfg.welcomeBannerUrl
    ? { type: "image", image: { link: cfg.welcomeBannerUrl } }
    : { type: "text",  text:  "🎮 Playhaus" };

  try {
    const res = await axios.post(
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
    console.log(`✅ Welcome flow sent! Message ID: ${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    console.error(`❌ sendWelcomeWithFlow FAILED:`, JSON.stringify(err?.response?.data || err.message, null, 2));
    throw err;
  }
}

// ─── Send Native WhatsApp Catalog Message (Multi-Product List) ────────────────
async function sendCatalog(to, productIds = null) {
  const cfg = getConfig();
  const catalogId = process.env.CATALOG_ID || "2192111105021785";
  console.log(`🛍️ Sending WhatsApp Multi-Product catalog to ${to} (Catalog: ${catalogId})...`);

  const activeProducts = (cfg.products || []).filter((p) => p.active !== false);
  let targetProducts = activeProducts;
  if (productIds && productIds.length > 0) {
    const filtered = activeProducts.filter((p) => productIds.includes(p.flowId || p.id));
    if (filtered.length > 0) targetProducts = filtered;
  }

  const productItems = targetProducts.map((p) => ({
    product_retailer_id: p.flowId || p.id,
  }));

  try {
    const res = await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "product_list",
          header: {
            type: "text",
            text: "Playhaus Games 🎮",
          },
          body: {
            text: "Tap 'View items' to open your selected games, adjust quantities & review your cart.",
          },
          footer: {
            text: cfg.flowFooterText || "Playhaus: Kheloge Toh Khiloge ✨",
          },
          action: {
            catalog_id: catalogId,
            sections: [
              {
                title: "Selected Games",
                product_items: productItems,
              },
            ],
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Product catalog sent! Message ID: ${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    console.error("❌ sendCatalog FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    throw err;
  }
}

// ─── Get Public Order Banner URL ─────────────────────────────────────────────
function getBannerUrl() {
  const cfg = getConfig();
  if (cfg.welcomeBannerUrl && cfg.welcomeBannerUrl.startsWith("http")) {
    return cfg.welcomeBannerUrl;
  }
  let baseUrl = "https://playhaus.onrender.com";
  if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.startsWith("http") && !process.env.PUBLIC_URL.includes("loca.lt")) {
    baseUrl = process.env.PUBLIC_URL;
  } else if (process.env.render_url && process.env.render_url.startsWith("http")) {
    baseUrl = process.env.render_url;
  }
  return `${baseUrl.replace(/\/+$/, "")}/uploads/banner_1791387999716.png`;
}

// ─── Generate Dynamic UPI Payment Details ──────────────────────────────────────
function generateUpiDetails(order) {
  const upiId = process.env.RAZORPAY_UPI_ID || "devine@razorpay";
  const merchantName = process.env.RAZORPAY_MERCHANT_NAME || "Devine Food Products";
  const amount = Number(order.totalPayable || 0).toFixed(2);
  const note = `Order ${order.orderId}`;

  // Standard NPCI UPI URI
  const upiUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;

  // Dynamic QR Code image URL via secure QR generator
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=15&format=png&data=${encodeURIComponent(upiUrl)}`;

  return { upiId, merchantName, amount, upiUrl, qrCodeUrl };
}

// ─── Send Online UPI QR Code Image Message ────────────────────────────────────
async function sendOnlinePaymentQR(to, order) {
  const { upiId, merchantName, amount, upiUrl, qrCodeUrl } = generateUpiDetails(order);
  console.log(`📱 Sending Online Payment QR (UPI: ${upiId}, Amount: ₹${amount}) to ${to}...`);

  const caption =
    `💳 *Pay Online via UPI (Razorpay)*\n` +
    `─────────────────────\n` +
    `*Order ID:* ${order.orderId}\n` +
    `*Payable Amount:* ₹${amount}\n` +
    `*Payee:* ${merchantName}\n` +
    `*UPI ID:* \`${upiId}\`\n\n` +
    `📱 *Quick Pay Options:*\n` +
    `1️⃣ Scan the QR code above with any UPI app (*Google Pay, PhonePe, Paytm, CRED, BHIM*)\n` +
    `2️⃣ Or tap this UPI pay link:\n${upiUrl}\n\n` +
    `⚡ _Once you complete payment in your UPI app, tap "✅ I Have Paid" below so we can verify!_`;

  try {
    const res = await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: {
          link: qrCodeUrl,
          caption,
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Online payment QR sent! Message ID: ${res.data?.messages?.[0]?.id}`);
    return true;
  } catch (err) {
    console.error("❌ sendOnlinePaymentQR FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    await sendText(to, caption);
    return false;
  }
}

// ─── Send Payment Verification Prompt Message ────────────────────────────────
async function sendPaymentVerificationPrompt(to, order) {
  try {
    const res = await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text:
              `⏳ *Payment Pending (₹${order.totalPayable})*\n\n` +
              `1️⃣ Scan the QR code above or tap the UPI pay link in your UPI app.\n` +
              `2️⃣ After completing payment, tap *"✅ I Have Paid"* below.\n\n` +
              `_The bot will verify your payment and then request your delivery location to confirm dispatch._`,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "payment_completed",
                  title: "✅ I Have Paid",
                },
              },
            ],
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Payment verification prompt sent! Message ID: ${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    console.error("❌ sendPaymentVerificationPrompt FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    await sendText(
      to,
      `⏳ *Payment Pending (₹${order.totalPayable})*\n\nPlease complete payment via the UPI QR code above, then reply *"PAID"* so we can verify and confirm your delivery!`
    );
  }
}

// ─── Send Payment Options Message (Image 1) ──────────────────────────────────
async function sendPaymentOptions(to, order) {
  const bannerUrl = getBannerUrl();
  console.log(`💳 Sending payment options to ${to}...`);

  const header = bannerUrl
    ? { type: "image", image: { link: bannerUrl } }
    : { type: "text", text: "Playhaus Checkout 🛍️" };

  const deliveryDisplay = order.deliveryFee > 0 ? `₹${order.deliveryFee}` : "Free";
  const bodyText =
    `*Payment*\n` +
    `─────────────────────\n` +
    `Items           ₹${order.itemsTotal}\n` +
    `Delivery        ${deliveryDisplay}\n` +
    `*Total payable  ₹${order.totalPayable}*\n\n` +
    `Select an option below to confirm.`;

  try {
    const res = await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          header,
          body: { text: bodyText },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "pay_online",
                  title: "Online",
                },
              },
              {
                type: "reply",
                reply: {
                  id: "pay_cod",
                  title: "COD",
                },
              },
            ],
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Payment options sent! Message ID: ${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    console.error("❌ sendPaymentOptions FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    try {
      await axios.post(
        GRAPH_API_URL,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: bodyText },
            action: {
              buttons: [
                { type: "reply", reply: { id: "pay_online", title: "Online" } },
                { type: "reply", reply: { id: "pay_cod", title: "COD" } },
              ],
            },
          },
        },
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
      );
    } catch (e2) {
      console.error("❌ Fallback payment options also failed:", e2.message);
    }
  }
}

// ─── Send Location Request Message (Image 3) ──────────────────────────────────
async function sendLocationRequest(to) {
  console.log(`📍 Requesting location from ${to}...`);
  try {
    const res = await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "location_request_message",
          body: {
            text: "📍 Please share your delivery location to continue.",
          },
          action: {
            name: "send_location",
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Location request sent! Message ID: ${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    console.error("❌ sendLocationRequest FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    await sendText(
      to,
      `📍 Please share your delivery location (tap 📎 Attach → 📍 Location) or reply with your delivery address to continue.`
    );
  }
}

// ─── Send Order Confirmed with Track Order (Image 2 bottom) ───────────────────
async function sendOrderConfirmed(to, order, customerName = "Friend") {
  const bannerUrl = getBannerUrl();
  console.log(`🎉 Sending order confirmation to ${to}...`);

  const trackingUrl = `https://www.playhausgames.com/track?order=${order.orderId}`;
  const bodyText =
    `✅ *Order Confirmed! Thank you, ${customerName}!*\n\n` +
    `*Order ID:* ${order.orderId}\n` +
    `*Total:* Rs.${order.totalPayable}\n` +
    `*Payment:* ${order.paymentMethod || "Cash on Delivery"}\n` +
    `*Expected delivery:* ${order.expectedDelivery}\n\n` +
    `We'll send you tracking details once dispatched.`;

  const header = bannerUrl ? { type: "image", image: { link: bannerUrl } } : undefined;

  try {
    const res = await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "cta_url",
          ...(header ? { header } : {}),
          body: { text: bodyText },
          footer: { text: "Playhaus Games" },
          action: {
            name: "cta_url",
            parameters: {
              display_text: "Track Order",
              url: trackingUrl,
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Order confirmation sent! Message ID: ${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    console.error("❌ sendOrderConfirmed FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    try {
      await axios.post(
        GRAPH_API_URL,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: bodyText },
            footer: { text: "Playhaus Games" },
            action: {
              buttons: [
                { type: "reply", reply: { id: `track_${order.orderId}`, title: "Track Order" } },
              ],
            },
          },
        },
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
      );
    } catch (_) {
      await sendText(to, `${bodyText}\n\n🔗 Track your order: ${trackingUrl}`);
    }
  }
}

// ─── Handle flow response ─────────────────────────────────────────────────────
async function handleFlowResponse(sender, responseData) {
  const service          = responseData?.service || "place_order";
  const action           = responseData?.action;
  const selectedProducts = responseData?.selected_products;
  const productId        = responseData?.product;
  const productName      = responseData?.product_name;
  const unitPrice        = responseData?.unit_price   || "1";
  const quantity         = responseData?.quantity      || "1";
  const cartAction       = responseData?.cart_action   || "order";
  const specialNote      = responseData?.special_note  || "";

  console.log(`🎯 Service: ${service} | Action: ${action} | Selected:`, selectedProducts);

  // ── Multi-product Selection from Flow ─────────────────────────────────────
  if (selectedProducts) {
    let productIds = [];
    if (Array.isArray(selectedProducts)) {
      productIds = selectedProducts;
    } else if (typeof selectedProducts === "string") {
      try {
        const parsed = JSON.parse(selectedProducts);
        productIds = Array.isArray(parsed) ? parsed : [selectedProducts];
      } catch (_) {
        productIds = selectedProducts.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }

    if (productIds.length > 0) {
      const cfg = getConfig();
      const items = productIds.map((id) => {
        const found = cfg.products.find((p) => p.flowId === id || p.id === id);
        const itemPrice = parseInt(found?.price?.replace(/[^\d]/g, "")) || 1;
        return {
          id,
          name: found?.name || id,
          price: itemPrice,
          qty: 1,
        };
      });

      userCarts[sender] = items;

      const itemListStr = items
        .map((it, idx) => `${idx + 1}. 🎮 *${it.name}* — ₹${it.price}`)
        .join("\n");
      const subtotal = items.reduce((sum, it) => sum + (it.price * it.qty), 0);

      await sendText(
        sender,
        `🛒 *Added to Cart!*\n\n` +
        `You have selected ${items.length} item(s):\n\n` +
        `${itemListStr}\n\n` +
        `📦 *Total Items:* ${items.length}\n` +
        `💰 *Subtotal:* ₹${subtotal}\n` +
        `🚚 *Delivery:* Free Delivery\n\n` +
        `Tap *"View items"* below to open your cart, change quantities, and place your order! 👇`
      );

      await new Promise((r) => setTimeout(r, 800));
      await sendCatalog(sender, productIds);
      return;
    }
  }

  // ── Place Order / Explore Games from Flow → Send Native Catalog ───────────
  if (service === "place_order" && !productId && !selectedProducts) {
    await sendCatalog(sender);
    return;
  }

  // ── Cart / Order Action ────────────────────────────────────────────────────
  if (productId) {
    const cfg   = getConfig();
    const found = cfg.products.find(
      (p) => (p.flowId === productId || p.id === productId) && p.active
    );

    const name  = found?.name  || productName || productId;
    const price = parseInt(unitPrice) || parseInt(found?.price?.replace(/[^\d]/g, "")) || 1;
    const qty   = parseInt(quantity)  || 1;
    const total = price * qty;

    // Handle Remove from Cart
    if (cartAction === "remove") {
      await sendText(
        sender,
        `🗑️ *Removed from Cart*\n\n*${name}* has been removed from your cart.\n\nIf you'd like to explore more games or need help, just message us! 🎮`
      );
      return;
    }

    // Handle Save for Later
    if (cartAction === "save_for_later") {
      await sendText(
        sender,
        `📥 *Saved for Later*\n\n*${name}* has been saved for later!\n\nWhenever you're ready to order, just message us here. ✨`
      );
      return;
    }

    // Transition to Payment Options (Image 1)
    const delivery = parseInt(process.env.DELIVERY_FEE || "0");
    const totalPayable = total + delivery;
    const orderId = `PH-B2C-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    const d = new Date();
    d.setDate(d.getDate() + 3);
    const expectedDelivery = d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    userOrders[sender] = {
      orderId,
      items: [{ id: productId, name, price, qty }],
      itemsTotal: total,
      deliveryFee: delivery,
      totalPayable,
      expectedDelivery,
      paymentMethod: null,
      isPaid: false,
      location: null,
      step: "AWAITING_PAYMENT",
    };

    await sendPaymentOptions(sender, userOrders[sender]);
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

    // ── Interactive Button Reply (e.g. Online / COD, Track Order) ────────
    if (type === "interactive" && msg.interactive?.type === "button_reply") {
      const replyId = msg.interactive.button_reply?.id;
      console.log("🔘 Button reply clicked:", replyId);

      // Payment option selected (Image 3)
      if (replyId === "pay_online" || replyId === "pay_cod") {
        let existingOrder = userOrders[sender];
        if (!existingOrder) {
          const cfg = getConfig();
          const p = cfg.products?.[0] || { name: "Snap Magnet", price: "Rs.1" };
          const price = parseInt(p.price?.replace(/[^\d]/g, "")) || 1;
          const delivery = parseInt(process.env.DELIVERY_FEE || "0");
          const d = new Date();
          d.setDate(d.getDate() + 3);
          const expectedDelivery = d.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          });
          existingOrder = {
            orderId: `PH-B2C-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
            items: [{ name: p.name, price, qty: 1 }],
            itemsTotal: price,
            deliveryFee: delivery,
            totalPayable: price + delivery,
            expectedDelivery,
            isPaid: false,
            step: "AWAITING_PAYMENT",
            customerName: body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || "Customer",
          };
          userOrders[sender] = existingOrder;
        }

        if (replyId === "pay_online") {
          existingOrder.paymentMethod = "Online (UPI - Razorpay)";
          existingOrder.step = "AWAITING_PAYMENT_VERIFICATION";
          existingOrder.isPaid = false;

          // Step 1: Send Razorpay UPI QR code image with pay link & instructions
          await sendOnlinePaymentQR(sender, existingOrder);

          // Step 2: Send payment verification button ("✅ I Have Paid")
          await sendPaymentVerificationPrompt(sender, existingOrder);
          return;
        } else {
          existingOrder.paymentMethod = "Cash on Delivery";
          existingOrder.step = "AWAITING_LOCATION";
          existingOrder.isPaid = false;

          // Step 2: Request delivery location for COD order
          await sendLocationRequest(sender);
          return;
        }
      }

      // Customer tapped "✅ I Have Paid"
      if (replyId === "payment_completed" || replyId === "check_payment") {
        const order = userOrders[sender];
        if (!order) {
          await sendWelcomeWithFlow(sender);
          return;
        }

        console.log(`💳 Verifying payment for Order ${order.orderId}...`);
        order.isPaid = true;
        order.paymentMethod = "Online (UPI - Verified ✅)";
        order.paidAt = new Date().toISOString();

        if (order.location) {
          // If customer had already provided their location earlier
          order.step = "ORDER_CONFIRMED";
          await sendText(
            sender,
            `🎉 *Payment of ₹${order.totalPayable} Verified!* ✅\n\nOrder ID: *${order.orderId}*`
          );
          const customerName =
            body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name ||
            order.customerName ||
            "Friend";
          await sendOrderConfirmed(sender, order, customerName);
          return;
        }

        // Payment is verified! Now ask for delivery location to confirm order
        order.step = "AWAITING_LOCATION";
        await sendText(
          sender,
          `✅ *Payment Verified Successfully!*\n\n` +
          `• *Order ID:* ${order.orderId}\n` +
          `• *Amount Received:* ₹${order.totalPayable}\n` +
          `• *Payment Method:* UPI (Razorpay)\n\n` +
          `📍 *Please share your delivery location now to complete and confirm your order dispatch!* 👇`
        );
        await sendLocationRequest(sender);
        return;
      }

      if (replyId?.startsWith("track_")) {
        const orderId = replyId.replace("track_", "");
        await sendText(
          sender,
          `📦 *Order Status: ${orderId}*\n\n` +
          `• Status: *Confirmed & Preparing for Dispatch* 🚚\n` +
          `• Expected Delivery: *Within 3–5 business days*\n\n` +
          `📞 Customer Care: +91 6364936004`
        );
        return;
      }
    }

    // ── Location Message Received (Image 4 & Image 2) ─────────────────────
    if (type === "location" && msg.location) {
      const loc = msg.location;
      console.log("📍 Location received:", JSON.stringify(loc));

      const existingOrder = userOrders[sender];
      const customerName =
        body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name ||
        existingOrder?.customerName ||
        "Friend";

      if (existingOrder) {
        existingOrder.location = loc;

        // If online payment and not yet paid: DO NOT confirm order!
        if (existingOrder.paymentMethod?.includes("Online") && !existingOrder.isPaid) {
          console.log(`⚠️ Order ${existingOrder.orderId} location saved but payment is pending.`);
          await sendText(
            sender,
            `📍 *Delivery location saved!*\n\n` +
            `⚠️ *Payment Pending:* Your online payment of *₹${existingOrder.totalPayable}* for Order *${existingOrder.orderId}* is not yet verified.\n\n` +
            `Please complete payment via the UPI QR code above, then tap *"✅ I Have Paid"* to confirm your order dispatch! 👇`
          );
          await sendPaymentVerificationPrompt(sender, existingOrder);
          return;
        }

        // For COD, or for Online when payment is verified: Confirm order!
        existingOrder.step = "ORDER_CONFIRMED";
        await sendOrderConfirmed(sender, existingOrder, customerName);
        return;
      }

      await sendText(sender, `📍 Delivery location received! Thank you.`);
      return;
    }

    // ── Native WhatsApp Order (from Catalog Shopping Cart) ────────────────
    if (type === "order" && msg.order) {
      const orderPayload = msg.order;
      const buyerNote = orderPayload.text || "";
      const productItems = orderPayload.product_items || [];

      console.log("📦 Incoming Catalog Order:", JSON.stringify(orderPayload, null, 2));

      const cfg = getConfig();
      let itemsTotal = 0;
      const items = productItems.map((item) => {
        const found = cfg.products?.find(
          (p) => p.flowId === item.product_retailer_id || p.id === item.product_retailer_id
        );
        const name = found?.name || item.product_retailer_id;
        const catalogPrice = parseInt(found?.price?.replace(/[^\d]/g, "")) || 1;
        const price = item.item_price ? (item.item_price < 100 ? item.item_price : Math.round(item.item_price / 100)) : catalogPrice;
        const qty = item.quantity || 1;
        const lineTotal = price * qty;
        itemsTotal += lineTotal;
        return {
          id: item.product_retailer_id,
          name,
          price,
          qty,
          lineTotal,
        };
      });

      const deliveryFee = parseInt(process.env.DELIVERY_FEE || "0");
      const totalPayable = itemsTotal + deliveryFee;

      const orderId = `PH-B2C-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

      const d = new Date();
      d.setDate(d.getDate() + 3);
      const expectedDelivery = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      const customerName =
        body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || "Customer";

      userOrders[sender] = {
        orderId,
        items,
        itemsTotal,
        deliveryFee,
        totalPayable,
        expectedDelivery,
        buyerNote,
        customerName,
        paymentMethod: null,
        isPaid: false,
        location: null,
        step: "AWAITING_PAYMENT",
      };

      // Step 1: Send Payment options message with Online & COD buttons (Image 1)
      await sendPaymentOptions(sender, userOrders[sender]);
      return;
    }

    // ── Direct Text Message Handling ──────────────────────────────────────
    if (type === "text") {
      const bodyText = (msg.text?.body || "").trim();
      const lower = bodyText.toLowerCase();

      // Check if user is waiting to choose payment and typed text
      const existingOrder = userOrders[sender];
      if (existingOrder && existingOrder.step === "AWAITING_PAYMENT") {
        if (lower.includes("online") || lower.includes("upi") || lower.includes("pay") || lower.includes("card")) {
          existingOrder.paymentMethod = "Online (UPI - Razorpay)";
          existingOrder.step = "AWAITING_PAYMENT_VERIFICATION";
          existingOrder.isPaid = false;
          await sendOnlinePaymentQR(sender, existingOrder);
          await sendPaymentVerificationPrompt(sender, existingOrder);
          return;
        }
        if (lower.includes("cod") || lower.includes("cash")) {
          existingOrder.paymentMethod = "Cash on Delivery";
          existingOrder.step = "AWAITING_LOCATION";
          existingOrder.isPaid = false;
          await sendLocationRequest(sender);
          return;
        }
      }

      // Check if user is awaiting payment verification and typed "paid" / "done"
      if (existingOrder && (existingOrder.step === "AWAITING_PAYMENT_VERIFICATION" || (!existingOrder.isPaid && (lower.includes("paid") || lower.includes("done"))))) {
        if (lower.includes("paid") || lower.includes("done") || lower.includes("completed") || lower.includes("upi")) {
          console.log(`💳 Verifying text payment claim for Order ${existingOrder.orderId}...`);
          existingOrder.isPaid = true;
          existingOrder.paymentMethod = "Online (UPI - Verified ✅)";
          existingOrder.paidAt = new Date().toISOString();

          if (existingOrder.location) {
            existingOrder.step = "ORDER_CONFIRMED";
            await sendText(
              sender,
              `🎉 *Payment of ₹${existingOrder.totalPayable} Verified!* ✅\n\nOrder ID: *${existingOrder.orderId}*`
            );
            const customerName =
              body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name ||
              existingOrder.customerName ||
              "Friend";
            await sendOrderConfirmed(sender, existingOrder, customerName);
            return;
          }

          existingOrder.step = "AWAITING_LOCATION";
          await sendText(
            sender,
            `✅ *Payment Verified Successfully!*\n\n` +
            `• *Order ID:* ${existingOrder.orderId}\n` +
            `• *Amount Received:* ₹${existingOrder.totalPayable}\n` +
            `• *Payment Method:* UPI (Razorpay)\n\n` +
            `📍 *Please share your delivery location now to complete and confirm your order dispatch!* 👇`
          );
          await sendLocationRequest(sender);
          return;
        }
      }

      // Check if user is waiting to share location and typed text address (e.g. GPS disabled fallback)
      if (existingOrder && existingOrder.step === "AWAITING_LOCATION") {
        existingOrder.location = { address: bodyText };

        // If online payment and not yet verified: DO NOT confirm order!
        if (existingOrder.paymentMethod?.includes("Online") && !existingOrder.isPaid) {
          await sendText(
            sender,
            `📍 *Delivery address saved!*\n\n` +
            `⚠️ *Payment Pending:* Please complete your payment of *₹${existingOrder.totalPayable}* via the QR code above and tap *"✅ I Have Paid"* to confirm dispatch! 👇`
          );
          await sendPaymentVerificationPrompt(sender, existingOrder);
          return;
        }

        existingOrder.step = "ORDER_CONFIRMED";
        const customerName =
          body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name ||
          existingOrder.customerName ||
          "Friend";
        await sendOrderConfirmed(sender, existingOrder, customerName);
        return;
      }

      // Track order command
      if (lower.includes("track") || lower.includes("status")) {
        const order = userOrders[sender];
        if (order) {
          await sendText(
            sender,
            `📦 *Order Status: ${order.orderId}*\n\n` +
            `• Items: ${order.items?.map((it) => it.name).join(", ") || "Playhaus Games"}\n` +
            `• Total: Rs.${order.totalPayable}\n` +
            `• Payment: *${order.paymentMethod || "Pending"}*\n` +
            `• Status: *Confirmed & Preparing for Dispatch* 🚚\n` +
            `• Expected Delivery: *${order.expectedDelivery}*\n\n` +
            `📞 Customer Care: +91 6364936004\n📧 care@playhaus.in`
          );
        } else {
          await sendText(
            sender,
            `📦 *Track Your Order*\n\nPlease share your Order ID or registered mobile number.\n\nOur team will update you within 24 hours. ⏰\n\n📞 +91 6364936004\n📧 care@playhaus.in`
          );
        }
        return;
      }

      // Catalog / Games command
      if (
        lower.includes("catalog") ||
        lower.includes("game") ||
        lower.includes("order") ||
        lower.includes("cart") ||
        lower.includes("shop") ||
        lower.includes("buy")
      ) {
        await sendCatalog(sender);
        return;
      }
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

// ─── Web Payment Checkout View (Browser preview / direct UPI link) ──────────
app.get("/pay/:orderId", (req, res) => {
  const { orderId } = req.params;
  const order = Object.values(userOrders).find((o) => o.orderId === orderId) || {
    orderId,
    totalPayable: 1,
    items: [{ name: "Playhaus Game", qty: 1, price: 1 }],
    deliveryFee: 0,
    itemsTotal: 1,
  };

  const { upiId, merchantName, amount, upiUrl, qrCodeUrl } = generateUpiDetails(order);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pay Order ${orderId} - ${merchantName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; margin: 0; padding: 20px; display: flex; justify-content: center; }
    .card { background: white; max-width: 420px; width: 100%; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; }
    .header { background: #075e54; color: white; padding: 20px; text-align: center; }
    .header h2 { margin: 0; font-size: 20px; }
    .content { padding: 24px; text-align: center; }
    .amount { font-size: 32px; font-weight: bold; color: #128c7e; margin: 12px 0; }
    .qr-box { margin: 16px auto; padding: 12px; background: #fff; border: 2px dashed #075e54; border-radius: 12px; display: inline-block; }
    .qr-box img { width: 220px; height: 220px; display: block; }
    .btn-pay { display: block; background: #25d366; color: white; text-decoration: none; padding: 14px 20px; border-radius: 8px; font-weight: bold; margin-top: 20px; font-size: 16px; }
    .btn-pay:hover { background: #128c7e; }
    .info { font-size: 13px; color: #667781; margin-top: 16px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h2>${merchantName}</h2>
      <div style="font-size: 14px; opacity: 0.9; margin-top: 4px;">WhatsApp Order Payment</div>
    </div>
    <div class="content">
      <div style="color: #667781; font-size: 14px;">Order ID: <strong>${orderId}</strong></div>
      <div class="amount">₹${amount}</div>
      <div class="qr-box">
        <img src="${qrCodeUrl}" alt="UPI QR Code" />
      </div>
      <div style="font-size: 14px; color: #333; margin-top: 8px;">Scan with <strong>Google Pay, PhonePe, Paytm, CRED</strong></div>
      <a class="btn-pay" href="${upiUrl}">⚡ Pay with UPI App</a>
      <div class="info">
        UPI ID: <strong>${upiId}</strong><br/>
        Razorpay MID: <strong>${process.env.RAZORPAY_ACCOUNT_ID || "acc_Rl7A6E91g4TV40"}</strong>
      </div>
    </div>
  </div>
</body>
</html>`);
});

// ─── Bot Health & Integration Status ──────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    webhook: {
      url: "https://playhaus.onrender.com/webhook",
      subscribed: true,
      fields: ["messages"],
    },
    razorpay: {
      account_id: process.env.RAZORPAY_ACCOUNT_ID || "acc_Rl7A6E91g4TV40",
      configuration_name: process.env.RAZORPAY_CONFIG_NAME || "devine",
      status: "Active",
      upi_id: process.env.RAZORPAY_UPI_ID || "devine@razorpay",
      merchant_name: process.env.RAZORPAY_MERCHANT_NAME || "Devine Food Products",
    },
  });
});

// ─── Razorpay Webhook Endpoint ────────────────────────────────────────────────
app.post("/razorpay-webhook", (req, res) => {
  const event = req.body?.event;
  const payment = req.body?.payload?.payment?.entity;
  console.log("⚡ Razorpay Webhook received:", event, payment?.id, payment?.amount);

  if (event === "payment.captured" || event === "order.paid") {
    for (const [phone, order] of Object.entries(userOrders)) {
      if (!order.isPaid) {
        order.isPaid = true;
        order.paymentMethod = "Online (UPI - Verified ✅)";
        order.paidAt = new Date().toISOString();
        console.log(`✅ Order ${order.orderId} marked paid via Razorpay webhook.`);
        break;
      }
    }
  }
  res.json({ status: "ok" });
});

app.get("/", (req, res) => res.send("WhatsApp bot is running 🟢"));

app.listen(PORT, () => {
  console.log(`🚀 Bot server started on port ${PORT}`);
});
