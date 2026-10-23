require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const mongoose = require("mongoose");
const Order         = require("./models/Order");
const UserSession   = require("./models/UserSession");
const SupportTicket = require("./models/SupportTicket");

const app = express();
app.use(express.json());

// ─── MongoDB Atlas Database Connection ───────────────────────────────────────
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://r26742387_db_user:JNqJipcxT7FbIXRw@cluster0.rytjyvn.mongodb.net/playhaus?retryWrites=true&w=majority&appName=Cluster0";

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("🍃 Connected to MongoDB Atlas (Database: playhaus)"))
  .catch((err) => console.error("❌ MongoDB Atlas connection error:", err.message));

// ─── Serve uploaded banners publicly (ngrok tunnels port 3000) ───────────────
app.use("/uploads", express.static(path.join(__dirname, "admin", "uploads")));

const { ACCESS_TOKEN, PHONE_NUMBER_ID, WEBHOOK_VERIFY_TOKEN, PORT = 10000, CATALOG_ID = "2192111105021785" } = process.env;
const GRAPH_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
const CONFIG_PATH   = path.join(__dirname, "config.json");
const FLOW_PATH     = path.join(__dirname, "flow.json");
const FLOW_ID       = "1090157514003637";
const userCarts     = {};
const userOrders    = {};
const userSessions  = {};

// ─── Database Sync Helpers ──────────────────────────────────────────────────
async function syncOrderToDb(sender, order) {
  if (!order || !order.orderId) return;
  userOrders[sender] = order;
  try {
    const orderDoc = {
      orderId: order.orderId,
      sender,
      customerName: order.customerName || "Customer",
      items: order.items || [],
      itemsTotal: Number(order.itemsTotal || 1),
      deliveryFee: Number(order.deliveryFee || 0),
      totalPayable: Number(order.totalPayable || 1),
      expectedDelivery: order.expectedDelivery || "",
      buyerNote: order.buyerNote || "",
      paymentMethod: order.paymentMethod || null,
      isPaid: Boolean(order.isPaid),
      paidAt: order.paidAt ? new Date(order.paidAt) : null,
      location: order.location || null,
      step: order.step || "AWAITING_PAYMENT",
      trackingNumber: order.trackingNumber || "",
      courier: order.courier || "BlueDart / Delhivery",
      trackingUrl: order.trackingUrl || "",
      statusUpdate: order.statusUpdate || "",
    };

    const saved = await Order.findOneAndUpdate(
      { orderId: order.orderId },
      { $set: orderDoc },
      { upsert: true, returnDocument: "after" }
    );
    console.log(`💾 Order ${order.orderId} synced to MongoDB Atlas.`);

    // Keep UserSession active
    try {
      await UserSession.findOneAndUpdate(
        { phone: sender },
        { $set: { activeOrderId: order.orderId, lastActiveAt: new Date() } },
        { upsert: true }
      );
    } catch (_) {}

    return saved;
  } catch (err) {
    console.error(`⚠️ Error syncing order ${order.orderId} to MongoDB:`, err.message);
  }
}

async function getActiveOrder(sender) {
  if (userOrders[sender]) return userOrders[sender];
  try {
    const doc = await Order.findOne({ sender }).sort({ createdAt: -1 });
    if (doc) {
      const orderObj = doc.toObject();
      userOrders[sender] = orderObj;
      return orderObj;
    }
  } catch (err) {
    console.error("⚠️ Error retrieving order from MongoDB:", err.message);
  }
  return null;
}

// ─── Database Order Search for Tracking (Exact ID, Regex, or Phone) ───────────
async function findOrderByIdOrSender(queryText, sender) {
  try {
    if (queryText) {
      const clean = String(queryText).trim().replace(/^#/, "");

      // 1. Direct exact orderId match
      let order = await Order.findOne({ orderId: clean });
      if (order) return order.toObject();

      // 2. Case-insensitive exact match
      order = await Order.findOne({ orderId: new RegExp(`^${clean}$`, "i") });
      if (order) return order.toObject();

      // 3. Match Order ID pattern (e.g. PH-B2C-XXXX or part of it)
      const match = clean.match(/(?:PH-B2C-|PH-)?([A-Z0-9]{4,10})/i);
      if (match) {
        order = await Order.findOne({ orderId: new RegExp(match[0], "i") });
        if (order) return order.toObject();
        order = await Order.findOne({ orderId: new RegExp(match[1], "i") });
        if (order) return order.toObject();
      }

      // 4. Match 10+ digit mobile number
      const digits = clean.replace(/\D/g, "");
      if (digits.length >= 10) {
        order = await Order.findOne({ sender: new RegExp(digits.slice(-10)) }).sort({ createdAt: -1 });
        if (order) return order.toObject();
      }
    }

    // 5. Look up latest order for current sender WhatsApp number
    if (sender) {
      const order = await Order.findOne({ sender }).sort({ createdAt: -1 });
      if (order) return order.toObject();
    }
  } catch (err) {
    console.error("⚠️ Error finding order in MongoDB:", err.message);
  }
  return null;
}

// ─── Log Customer Support Inquiries to MongoDB ────────────────────────────────
async function logSupportTicket(sender, customerName, message, linkedOrderId = null) {
  try {
    const ticketId = `TKT-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    const ticket = await SupportTicket.create({
      ticketId,
      sender,
      customerName: customerName || "Customer",
      message,
      linkedOrderId,
      status: "OPEN",
    });
    console.log(`🎫 Support ticket ${ticketId} created in MongoDB for ${sender}`);
    return ticket;
  } catch (err) {
    console.error("⚠️ Error logging support ticket:", err.message);
    return null;
  }
}

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

  const bannerUrl = getBannerUrl();
  const header = bannerUrl
    ? { type: "image", image: { link: bannerUrl } }
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
    if (header.type === "image") {
      try {
        console.log("ℹ️ Retrying welcome flow with text header fallback...");
        await axios.post(
          GRAPH_API_URL,
          {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "interactive",
            interactive: {
              type:   "flow",
              header: { type: "text", text: "🎮 Playhaus" },
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
        return;
      } catch (_) {}
    }
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

// ─── Get Public Base URL ──────────────────────────────────────────────────────
function getPublicBaseUrl() {
  let baseUrl = "https://playhaus.onrender.com";
  if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.startsWith("http") && !process.env.PUBLIC_URL.includes("loca.lt")) {
    baseUrl = process.env.PUBLIC_URL;
  } else if (process.env.render_url && process.env.render_url.startsWith("http")) {
    baseUrl = process.env.render_url;
  }
  return baseUrl.replace(/\/+$/, "");
}

// ─── Get Public Order Banner URL ─────────────────────────────────────────────
function getBannerUrl() {
  const cfg = getConfig();
  if (cfg.welcomeBannerUrl && cfg.welcomeBannerUrl.startsWith("http")) {
    return cfg.welcomeBannerUrl;
  }
  const baseUrl = getPublicBaseUrl();
  return `${baseUrl}/uploads/banner_1791387999716.png`;
}

// ─── Generate Dynamic UPI Payment Details ──────────────────────────────────────
function generateUpiDetails(order) {
  const upiId = process.env.RAZORPAY_UPI_ID || "8801414663@ybl";
  const merchantName = process.env.RAZORPAY_MERCHANT_NAME || "vijay g";
  const amount = Number(order.totalPayable || 0).toFixed(2);
  const note = `Order ${order.orderId}`;
  const tr = String(order.orderId || "PH").replace(/[^a-zA-Z0-9]/g, "");

  // Standard NPCI UPI URI with transaction reference (tr)
  const upiUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}&tr=${encodeURIComponent(tr)}`;

  // Dynamic QR Code image URL via secure QR generator
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=15&format=png&data=${encodeURIComponent(upiUrl)}`;

  return { upiId, merchantName, amount, upiUrl, qrCodeUrl, tr };
}

// ─── Send Order Review Card (Exact Replica of WhatsApp In-Chat Order Details) ───
async function sendOrderReviewCard(to, order) {
  const cfg = getConfig();
  const firstItem = order.items?.[0] || {};
  let productImageUrl = firstItem.imageUrl;
  if (!productImageUrl) {
    const found = cfg.products?.find((p) => p.name === firstItem.name || p.id === firstItem.id || p.flowId === firstItem.id);
    productImageUrl = found?.imageUrl;
  }
  if (!productImageUrl) {
    productImageUrl = getBannerUrl();
  }

  const baseUrl = getPublicBaseUrl();
  const amountNumber = Number(order.totalPayable || 1);
  const amountFormatted = amountNumber.toFixed(2);
  const totalPaise = Math.round(amountNumber * 100);

  console.log(`🧾 Sending Order Review card for Order ${order.orderId} to ${to}...`);

  // Attempt 1: Try Native WhatsApp Pay "order_details" Interactive Message
  const orderItemsPayload = (order.items || []).map((it) => ({
    retailer_id: it.id || "playhaus_game",
    name: it.name || "Playhaus Game",
    amount: {
      value: Math.round(Number(it.price || 1) * 100),
      offset: 100,
    },
    quantity: it.qty || 1,
  }));

  const nativeOrderPayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "order_details",
      header: productImageUrl
        ? { type: "image", image: { link: productImageUrl } }
        : undefined,
      body: {
        text: "Review your items and pay securely via UPI.",
      },
      footer: {
        text: "Powered by WhatsApp Pay",
      },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: order.orderId,
          type: "digital-goods",
          currency: "INR",
          total_amount: {
            value: totalPaise,
            offset: 100,
          },
          payment_settings: [
            {
              type: "payment_gateway",
              payment_gateway: {
                type: "razorpay",
                configuration_name: process.env.RAZORPAY_CONFIG_NAME || "devine",
              },
            },
          ],
          order: {
            status: "pending",
            items: orderItemsPayload.length > 0 ? orderItemsPayload : [
              {
                retailer_id: "snap_magnet",
                name: "Snap Magnet",
                amount: { value: totalPaise, offset: 100 },
                quantity: 1,
              },
            ],
            subtotal: {
              value: totalPaise,
              offset: 100,
            },
            tax: { value: 0, offset: 100 },
            shipping: { value: 0, offset: 100 },
          },
        },
      },
    },
  };

  try {
    const res = await axios.post(GRAPH_API_URL, nativeOrderPayload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    console.log(`✅ Native order_details sent! Message ID: ${res.data?.messages?.[0]?.id}`);
    return true;
  } catch (nativeErr) {
    const errDetails = nativeErr?.response?.data?.error?.error_data?.details || nativeErr?.response?.data?.error?.message || nativeErr.message;
    console.log(`ℹ️ Native order_details not supported on this phone number (${errDetails}). Sending exact visual CTA card...`);
  }

  // Attempt 2: Visual Match CTA Card (renders identical WhatsApp order card with product thumbnail, ORDER #, items, total & Pay now button)
  const itemsText = (order.items || [])
    .map((it) => `${it.name}\nQuantity ${it.qty || 1}`)
    .join("\n\n") || "Snap Magnet\nQuantity 1";

  const cardBody =
    `ORDER #${order.orderId}\n` +
    `─────────────────────\n` +
    `${itemsText}\n\n` +
    `*Total                                            ₹${amountFormatted}*\n\n` +
    `🧾 *Order #${order.orderId}*\n` +
    `Review your items and pay securely via UPI.`;

  const fallbackCardPayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      header: {
        type: "image",
        image: { link: productImageUrl },
      },
      body: {
        text: cardBody,
      },
      footer: {
        text: "Powered by WhatsApp Pay",
      },
      action: {
        name: "cta_url",
        parameters: {
          display_text: "Pay now",
          url: `${baseUrl}/pay/upi/${order.orderId}`,
        },
      },
    },
  };

  try {
    const res2 = await axios.post(GRAPH_API_URL, fallbackCardPayload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    console.log(`✅ Order review card sent! Message ID: ${res2.data?.messages?.[0]?.id}`);
    return true;
  } catch (cardErr) {
    console.error("❌ sendOrderReviewCard FAILED:", JSON.stringify(cardErr?.response?.data || cardErr.message, null, 2));
    return false;
  }
}

// ─── Send Direct 1-Tap UPI App Launcher ───────────────────────────────────────
async function sendAppPaymentLauncher(to, order, appChoice) {
  const baseUrl = getPublicBaseUrl();
  const amount = Number(order.totalPayable || 1).toFixed(2);
  const appNames = {
    gpay: { name: "Google Pay", emoji: "🟢", button: "Pay on Google Pay" },
    phonepe: { name: "PhonePe", emoji: "🟣", button: "Pay on PhonePe" },
    paytm: { name: "Paytm", emoji: "🔵", button: "Pay on Paytm" },
    upi: { name: "UPI App", emoji: "⚡", button: "Open UPI App" },
  };

  const app = appNames[appChoice] || appNames.upi;
  const payUrl = `${baseUrl}/pay/${appChoice}/${order.orderId}`;

  const bodyText =
    `${app.emoji} *${app.name} Selected*\n\n` +
    `*Order ID:* ${order.orderId}\n` +
    `*Amount:* ₹${amount}\n\n` +
    `Tap the button below to launch ${app.name} and complete your payment. 👇`;

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
          body: { text: bodyText },
          footer: { text: "Playhaus Games" },
          action: {
            name: "cta_url",
            parameters: {
              display_text: app.button,
              url: payUrl,
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ App launcher sent for ${appChoice}! Message ID: ${res.data?.messages?.[0]?.id}`);
    return true;
  } catch (err) {
    console.error("❌ sendAppPaymentLauncher FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    await sendText(to, `${bodyText}\n\n👉 Pay: ${payUrl}`);
    return false;
  }
}

// ─── Send Online UPI QR Code Image Message + Interactive App Selector (1 Single Message) ───
async function sendOnlinePaymentQR(to, order) {
  const { upiId, merchantName, amount, qrCodeUrl } = generateUpiDetails(order);
  const baseUrl = getPublicBaseUrl();
  console.log(`📱 Sending Online Payment QR with App Selector (Amount: ₹${amount}) to ${to}...`);

  const qrCardBody =
    `💳 *Pay Online via UPI*\n` +
    `─────────────────────\n` +
    `*Order ID:* ${order.orderId}\n` +
    `*Amount to Pay:* ₹${amount}\n` +
    `*Payee:* ${merchantName}\n` +
    `*UPI ID:* \`${upiId}\`\n\n` +
    `_Scan the QR code above or select your UPI app below:_`;

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
          header: {
            type: "image",
            image: { link: qrCodeUrl },
          },
          body: { text: qrCardBody },
          footer: { text: "Playhaus Games • UPI Payment" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "pay_app_gpay", title: "🟢 Google Pay" } },
              { type: "reply", reply: { id: "pay_app_phonepe", title: "🟣 PhonePe" } },
              { type: "reply", reply: { id: "pay_app_paytm", title: "🔵 Paytm" } },
            ],
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Single QR + App Buttons message sent! Message ID: ${res.data?.messages?.[0]?.id}`);
    return true;
  } catch (err) {
    console.error("❌ sendOnlinePaymentQR FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    try {
      await axios.post(
        GRAPH_API_URL,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "cta_url",
            header: { type: "image", image: { link: qrCodeUrl } },
            body: { text: qrCardBody },
            footer: { text: "Playhaus Games" },
            action: {
              name: "cta_url",
              parameters: {
                display_text: "⚡ Pay with UPI",
                url: `${baseUrl}/pay/upi/${order.orderId}`,
              },
            },
          },
        },
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
      );
    } catch (_) {
      await sendText(to, `${qrCardBody}\n\n👉 Pay: ${baseUrl}/pay/${order.orderId}`);
    }
    return false;
  }
}

// ─── Real Payment Verification & Success Notification ─────────────────────────
async function handlePaymentSuccess(sender, order) {
  if (!order || order.isPaid) return;
  console.log(`🎉 Payment confirmed for Order ${order.orderId} from ${sender}!`);

  order.isPaid = true;
  order.paidAt = new Date().toISOString();
  order.paymentMethod = "Online (UPI - Verified ✅)";

  // Sync paid status to MongoDB Atlas
  await syncOrderToDb(sender, order);

  // 1. Notify customer in WhatsApp that payment was received
  await sendText(
    sender,
    `🎉 *Payment Received!*\n\n` +
    `We have received your payment of *₹${order.totalPayable}* via UPI (Razorpay) for Order *${order.orderId}*. ✅\n\n` +
    `📍 *Please share your delivery location to confirm your order dispatch.* 👇`
  );

  // 2. If customer had already provided their location earlier, confirm immediately!
  if (order.location) {
    order.step = "ORDER_CONFIRMED";
    await syncOrderToDb(sender, order);
    await sendOrderConfirmed(sender, order, order.customerName || "Friend");
    return;
  }

  // 3. Ask for delivery location
  order.step = "AWAITING_LOCATION";
  await syncOrderToDb(sender, order);
  await sendLocationRequest(sender);
}

// ─── Optional: Razorpay API Real-Time Verification ───────────────────────────
async function checkRazorpayApiPayment(order) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return false;

  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const res = await axios.get("https://api.razorpay.com/v1/payments?count=10", {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 5000,
    });
    const items = res.data?.items || [];
    const expectedPaise = Math.round(Number(order.totalPayable) * 100);
    const match = items.find((p) => {
      const isCaptured = p.status === "captured";
      const amountMatches = p.amount === expectedPaise;
      const noteMatches = p.notes?.order_id === order.orderId || p.description?.includes(order.orderId);
      return isCaptured && (noteMatches || amountMatches);
    });
    return !!match;
  } catch (err) {
    console.error("Razorpay API check error:", err.message);
    return false;
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

  const baseUrl = getPublicBaseUrl();
  const trackingUrl = `${baseUrl}/track/${order.orderId}`;
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

// ─── Send Rich Interactive Order Tracking Card ──────────────────────────────
async function sendOrderTrackingCard(to, order) {
  const bannerUrl = getBannerUrl();
  console.log(`📦 Sending live tracking card for Order ${order.orderId} to ${to}...`);

  const itemsList = (order.items || [])
    .map((it) => `• *${it.name}* × ${it.qty || 1} (₹${it.price || 1})`)
    .join("\n") || "• Snap Magnet × 1 (₹1)";

  const dateStr = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Recently placed";

  let statusText = "🟢 Confirmed & Preparing for Dispatch";
  let statusVisual = "━━━━━━━━━━━━━━○───────\n📦 Confirmed ➔ 🚚 Shipped ➔ 🏡 Delivered";

  if (order.step === "AWAITING_PAYMENT") {
    statusText = "⏳ Awaiting Payment";
    statusVisual = "○─────────────────────\n💳 Pay Now ➔ 📦 Confirmed ➔ 🏡 Delivered";
  } else if (order.step === "AWAITING_LOCATION") {
    statusText = "📍 Payment Received — Waiting for Delivery Address";
    statusVisual = "━━━━━━━○──────────────\n💳 Paid ➔ 📍 Address ➔ 🏡 Delivered";
  } else if (order.step === "SHIPPED") {
    statusText = `🚚 Shipped via ${order.courier || "Delhivery"}`;
    if (order.trackingNumber) statusText += `\n📦 *AWB / Tracking #:* \`${order.trackingNumber}\``;
    statusVisual = "━━━━━━━━━━━━━━━━━━━━○─\n📦 Confirmed ➔ 🚚 Shipped ➔ 🏡 Delivered";
  } else if (order.step === "OUT_FOR_DELIVERY") {
    statusText = "🛵 Out for Delivery Today!";
    statusVisual = "━━━━━━━━━━━━━━━━━━━━━━\n🚚 Shipped ➔ 🛵 Out for Delivery ➔ 🏡 Delivered";
  } else if (order.step === "DELIVERED") {
    statusText = "🎉 Delivered Successfully!";
    statusVisual = "━━━━━━━━━━━━━━━━━━━━━━\n📦 Confirmed ➔ 🚚 Shipped ➔ 🏡 Delivered ✅";
  }

  const addressDisplay = order.location?.address
    ? order.location.address
    : order.location
    ? "📍 Live GPS Location Saved"
    : "_Address not shared yet_";

  const paymentDisplay = order.isPaid
    ? `Paid via ${order.paymentMethod || "UPI"} ✅`
    : order.paymentMethod === "Cash on Delivery"
    ? "Cash on Delivery 💵"
    : "Payment Pending ⏳";

  const cardBody =
    `📦 *ORDER TRACKING DETAILS*\n` +
    `─────────────────────\n` +
    `🧾 *Order ID:* \`${order.orderId}\`\n` +
    `📅 *Order Date:* ${dateStr}\n` +
    `👤 *Customer:* ${order.customerName || "Customer"}\n\n` +
    `🎮 *Items Ordered:*\n` +
    `${itemsList}\n\n` +
    `💰 *Total Amount:* ₹${order.totalPayable} (${paymentDisplay})\n` +
    `📍 *Delivery Address:*\n${addressDisplay}\n\n` +
    `🚚 *Current Status:*\n` +
    `*${statusText}*\n` +
    `\`${statusVisual}\`\n\n` +
    `📅 *Expected Delivery:* ${order.expectedDelivery || "Within 3–5 business days"}\n\n` +
    `_Need any changes or help? Tap Support below!_`;

  const buttons = [
    { type: "reply", reply: { id: "btn_support", title: "🎧 Support" } },
    { type: "reply", reply: { id: "btn_catalog", title: "🛍️ View Games" } },
  ];

  if (order.step === "AWAITING_PAYMENT" && !order.isPaid) {
    buttons.unshift({ type: "reply", reply: { id: "pay_online", title: "⚡ Pay Now" } });
  }

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
          header: {
            type: "image",
            image: { link: bannerUrl },
          },
          body: { text: cardBody },
          footer: { text: "Playhaus Games • Order Tracking" },
          action: { buttons: buttons.slice(0, 3) },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Tracking card sent for ${order.orderId} to ${to}`);
    return true;
  } catch (err) {
    console.error("❌ sendOrderTrackingCard FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    await sendText(to, cardBody);
    return false;
  }
}

// ─── Send Customer Support Menu ───────────────────────────────────────────────
async function sendCustomerSupportMenu(to) {
  const bannerUrl = getBannerUrl();
  console.log(`🎧 Sending Customer Support menu to ${to}...`);

  const bodyText =
    `🎧 *Playhaus Customer Care*\n` +
    `─────────────────────\n` +
    `Welcome! We're here to help you with orders, delivery, game queries, and replacements. 😊\n\n` +
    `📞 *Direct Helpline:* +91 6364936004\n` +
    `💬 *WhatsApp Hours:* Mon–Sat, 10:00 AM – 6:00 PM\n` +
    `📧 *Email:* care@playhaus.in\n` +
    `🌐 *Website:* playhausgames.com\n\n` +
    `*How can we assist you today?*\n` +
    `• Reply with your question or concern directly here\n` +
    `• Or tap an option below: 👇`;

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
          header: {
            type: "image",
            image: { link: bannerUrl },
          },
          body: { text: bodyText },
          footer: { text: "Playhaus Support • Fast Resolution" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "btn_track_order", title: "📦 Track Order" } },
              { type: "reply", reply: { id: "btn_talk_agent", title: "💬 Leave a Message" } },
              { type: "reply", reply: { id: "btn_catalog", title: "🛍️ View Games" } },
            ],
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Support menu sent to ${to}`);
    return true;
  } catch (err) {
    console.error("❌ sendCustomerSupportMenu FAILED:", JSON.stringify(err?.response?.data || err.message, null, 2));
    await sendText(to, `${bodyText}\n\n👉 Reply directly to chat with support!`);
    return false;
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

  console.log(`🎯 Service selected: ${service} | Action: ${action} | Selected:`, selectedProducts);

  // ── 1. Priority Service Routing: Track Order ─────────────────────────────
  if (service === "track_order") {
    console.log(`📦 Handling Track Order service request from ${sender}`);
    const order = await findOrderByIdOrSender(null, sender);
    if (order) {
      await sendOrderTrackingCard(sender, order);
      return;
    }
    await sendText(
      sender,
      `📦 *Track Your Order*\n\n` +
      `We checked our database, but didn't find any recent orders placed from this WhatsApp number (*+${sender}*).\n\n` +
      `🔎 *Have an Order ID?*\n` +
      `Simply reply with your Order ID (e.g. *PH-B2C-XXXXX*) or registered 10-digit mobile number, and we'll pull up your tracking details right away!`
    );
    userSessions[sender] = { state: "AWAITING_TRACKING_QUERY" };
    return;
  }

  // ── 2. Priority Service Routing: Customer Support ────────────────────────
  if (service === "customer_support") {
    console.log(`🎧 Handling Customer Support service request from ${sender}`);
    await sendCustomerSupportMenu(sender);
    userSessions[sender] = { state: "AWAITING_SUPPORT_MESSAGE" };
    return;
  }

  // ── 3. Multi-product Selection from Flow (Place Order) ───────────────────
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

      // Directly display the native shopping cart without intermediate text message
      await sendCatalog(sender, productIds);
      return;
    }
  }

  // ── 4. Place Order / Explore Games from Flow → Send Native Catalog ────────
  if (service === "place_order" && !productId && !selectedProducts) {
    await sendCatalog(sender);
    return;
  }

  // ── 5. Cart / Order Action ────────────────────────────────────────────────
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
    await syncOrderToDb(sender, userOrders[sender]);

    await sendPaymentOptions(sender, userOrders[sender]);
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
        let existingOrder = await getActiveOrder(sender);
        if (!existingOrder) {
          const cfg = getConfig();
          const p = cfg.products?.[0] || { name: "Snap Magnet", price: "Rs.1", imageUrl: "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-snap-magnet-3.webp?v=1785878825" };
          const price = 1;
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
            items: [{ name: p.name, price: 1, qty: 1, imageUrl: p.imageUrl, id: p.flowId || p.id }],
            itemsTotal: 1,
            deliveryFee: delivery,
            totalPayable: 1 + delivery,
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
          await syncOrderToDb(sender, existingOrder);

          // Exactly 1 message: Razorpay UPI QR code image with direct UPI app buttons
          await sendOnlinePaymentQR(sender, existingOrder);
          return;
        } else {
          existingOrder.paymentMethod = "Cash on Delivery";
          existingOrder.step = "AWAITING_LOCATION";
          existingOrder.isPaid = false;
          await syncOrderToDb(sender, existingOrder);

          // Request delivery location for COD order
          await sendLocationRequest(sender);
          return;
        }
      }

      // App selection button clicked on the QR card
      if (replyId?.startsWith("pay_app_")) {
        const appChoice = replyId.replace("pay_app_", ""); // "gpay", "phonepe", "paytm", "upi"
        const existingOrder = (await getActiveOrder(sender)) || {
          orderId: `PH-B2C-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
          totalPayable: 1,
        };
        await sendAppPaymentLauncher(sender, existingOrder, appChoice);
        return;
      }

      if (replyId?.startsWith("track_")) {
        const orderId = replyId.replace("track_", "");
        const order = await findOrderByIdOrSender(orderId, sender);
        if (order) {
          await sendOrderTrackingCard(sender, order);
        } else {
          await sendText(
            sender,
            `📦 *Order Status: ${orderId}*\n\n` +
            `• Status: *Confirmed & Preparing for Dispatch* 🚚\n` +
            `• Expected Delivery: *Within 3–5 business days*\n\n` +
            `📞 Customer Care: +91 6364936004`
          );
        }
        return;
      }

      if (replyId === "btn_track_order" || replyId === "track_order") {
        const order = await findOrderByIdOrSender(null, sender);
        if (order) {
          await sendOrderTrackingCard(sender, order);
        } else {
          await sendText(
            sender,
            `📦 *Track Your Order*\n\n` +
            `Please reply with your *Order ID* (e.g. *PH-B2C-XXXXX*) or registered 10-digit mobile number, and we'll pull up your details! 🔎\n\n` +
            `📞 Support: +91 6364936004`
          );
          userSessions[sender] = { state: "AWAITING_TRACKING_QUERY" };
        }
        return;
      }

      if (replyId === "btn_support" || replyId === "btn_talk_agent" || replyId === "customer_support") {
        await sendCustomerSupportMenu(sender);
        userSessions[sender] = { state: "AWAITING_SUPPORT_MESSAGE" };
        return;
      }

      if (replyId === "btn_catalog" || replyId === "btn_browse_games" || replyId === "place_order") {
        await sendCatalog(sender);
        return;
      }
    }

    // ── Interactive List Reply (e.g. UPI App Selection, Menu) ─────────────
    if (type === "interactive" && msg.interactive?.type === "list_reply") {
      const listId = msg.interactive.list_reply?.id;
      console.log("📋 List reply clicked:", listId);

      if (listId === "btn_track_order" || listId === "track_order") {
        const order = await findOrderByIdOrSender(null, sender);
        if (order) {
          await sendOrderTrackingCard(sender, order);
        } else {
          await sendText(
            sender,
            `📦 *Track Your Order*\n\n` +
            `Please reply with your *Order ID* (e.g. *PH-B2C-XXXXX*) or registered 10-digit mobile number, and we'll pull up your details! 🔎\n\n` +
            `📞 Support: +91 6364936004`
          );
          userSessions[sender] = { state: "AWAITING_TRACKING_QUERY" };
        }
        return;
      }

      if (listId === "btn_support" || listId === "btn_talk_agent" || listId === "customer_support") {
        await sendCustomerSupportMenu(sender);
        userSessions[sender] = { state: "AWAITING_SUPPORT_MESSAGE" };
        return;
      }

      if (listId === "btn_catalog" || listId === "btn_browse_games" || listId === "place_order") {
        await sendCatalog(sender);
        return;
      }

      if (listId?.startsWith("pay_app_")) {
        const appChoice = listId.replace("pay_app_", ""); // "gpay", "phonepe", "paytm", "upi"
        const existingOrder = userOrders[sender] || {
          orderId: `PH-B2C-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
          totalPayable: 1,
        };
        await sendAppPaymentLauncher(sender, existingOrder, appChoice);
        return;
      }
    }

    // ── Location Message Received (Image 4 & Image 2) ─────────────────────
    if (type === "location" && msg.location) {
      const loc = msg.location;
      console.log("📍 Location received:", JSON.stringify(loc));

      const existingOrder = await getActiveOrder(sender);
      const customerName =
        body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name ||
        existingOrder?.customerName ||
        "Friend";

      if (existingOrder) {
        existingOrder.location = loc;
        await syncOrderToDb(sender, existingOrder);

        // If online payment and not yet paid: DO NOT confirm order!
        if (existingOrder.paymentMethod?.includes("Online") && !existingOrder.isPaid) {
          console.log(`⚠️ Order ${existingOrder.orderId} location saved but payment is pending.`);
          await sendText(
            sender,
            `📍 *Delivery location saved!*\n\n` +
            `⚠️ *Payment Pending:* Your online payment of *₹${existingOrder.totalPayable}* for Order *${existingOrder.orderId}* is not yet received.\n\n` +
            `Please tap your UPI app (Google Pay, PhonePe, Paytm) above to complete payment. As soon as your payment is confirmed, your order will be dispatched immediately!`
          );
          return;
        }

        // For COD, or for Online when payment is verified: Confirm order!
        existingOrder.step = "ORDER_CONFIRMED";
        await syncOrderToDb(sender, existingOrder);
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
        const imageUrl = found?.imageUrl || "";
        const catalogPrice = parseInt(found?.price?.replace(/[^\d]/g, "")) || 1;
        let price = catalogPrice;
        if (typeof item.item_price === "number") {
          if (item.item_price === 100) {
            price = 1;
          } else if (item.item_price < 100 && item.item_price > 0) {
            price = item.item_price;
          }
        }
        // Ensure sample products configured at 1 Rupee are strictly 1 Rupee
        if (catalogPrice === 1) {
          price = 1;
        }
        const qty = item.quantity || 1;
        const lineTotal = price * qty;
        itemsTotal += lineTotal;
        return {
          id: item.product_retailer_id,
          name,
          imageUrl,
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
      await syncOrderToDb(sender, userOrders[sender]);

      // Step 1: Send Payment options message with Online & COD buttons (Image 1)
      await sendPaymentOptions(sender, userOrders[sender]);
      return;
    }

    // ── Direct Text Message Handling ──────────────────────────────────────
    if (type === "text") {
      const bodyText = (msg.text?.body || "").trim();
      const lower = bodyText.toLowerCase();

      // Retrieve customer's active order directly from MongoDB (survives restarts)
      const existingOrder = await getActiveOrder(sender);

      // ── Check if user is leaving a support message ────────────────────────
      if (userSessions[sender]?.state === "AWAITING_SUPPORT_MESSAGE") {
        userSessions[sender].state = null;
        const customerName =
          body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name ||
          existingOrder?.customerName ||
          "Customer";
        const ticket = await logSupportTicket(sender, customerName, bodyText, existingOrder?.orderId);
        const ticketId = ticket?.ticketId || `TKT-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

        await sendText(
          sender,
          `✅ *Support Ticket Created (#${ticketId})*\n\n` +
          `Thank you for messaging us, *${customerName}*! We have received your query:\n\n` +
          `> "${bodyText}"\n\n` +
          `Our support team has been notified and will reply right here on WhatsApp within business hours (Mon–Sat, 10am–6pm). ⏰\n\n` +
          `📞 For urgent escalations, call us directly at *+91 6364936004*.`
        );
        return;
      }

      // ── Check if user triggers Customer Support ────────────────────────────
      const isSupportKeyword =
        lower === "help" ||
        lower === "support" ||
        lower.includes("customer care") ||
        lower.includes("customer support") ||
        lower.includes("contact") ||
        lower.includes("helpline") ||
        lower.includes("agent") ||
        lower.includes("executive") ||
        lower.includes("talk to human") ||
        lower.includes("complaint") ||
        lower.includes("refund") ||
        lower.includes("return") ||
        lower.includes("damaged") ||
        lower.includes("broken") ||
        lower.includes("wrong item") ||
        lower.includes("issue") ||
        lower.includes("problem");

      if (isSupportKeyword) {
        console.log(`🎧 Support keyword detected from ${sender}: "${bodyText}"`);
        await sendCustomerSupportMenu(sender);
        userSessions[sender] = { state: "AWAITING_SUPPORT_MESSAGE" };
        return;
      }

      // ── Check if user triggers Order Tracking or typed an Order ID ─────────
      const isOrderIdDirect = /^(?:#)?(?:PH-)?(?:B2C-)?[A-Z0-9]{4,10}$/i.test(bodyText.trim());
      const isTrackKeyword =
        lower.includes("track") ||
        lower.includes("status") ||
        lower.includes("where is my order") ||
        lower.includes("where is my package") ||
        lower.includes("tracking") ||
        lower.includes("dispatch") ||
        lower.includes("delivery date") ||
        lower.includes("my order") ||
        lower.includes("check order") ||
        userSessions[sender]?.state === "AWAITING_TRACKING_QUERY";

      if (isOrderIdDirect || isTrackKeyword) {
        if (userSessions[sender]) userSessions[sender].state = null;
        console.log(`📦 Order tracking requested by ${sender} (Query: "${bodyText}")`);
        const order = await findOrderByIdOrSender(bodyText, sender);
        if (order) {
          await sendOrderTrackingCard(sender, order);
          return;
        } else {
          await sendText(
            sender,
            `🔍 *Order Not Found*\n\n` +
            `We couldn't find an order matching *"${bodyText}"* or linked to your WhatsApp number (*+${sender}*).\n\n` +
            `• Please check your Order ID (format: *PH-B2C-XXXXX*)\n` +
            `• If you used a different mobile number when placing the order, reply with that 10-digit number.\n\n` +
            `📞 Need immediate assistance? Reply *support* or call *+91 6364936004*.`
          );
          userSessions[sender] = { state: "AWAITING_TRACKING_QUERY" };
          return;
        }
      }

      // Check if user is waiting to choose payment and typed text
      if (existingOrder && existingOrder.step === "AWAITING_PAYMENT") {
        if (lower.includes("online") || lower.includes("upi") || lower.includes("pay") || lower.includes("card")) {
          existingOrder.paymentMethod = "Online (UPI - Razorpay)";
          existingOrder.step = "AWAITING_PAYMENT_VERIFICATION";
          existingOrder.isPaid = false;
          await syncOrderToDb(sender, existingOrder);
          await sendOnlinePaymentQR(sender, existingOrder);
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

      // Check if user is awaiting payment verification and asks status or claims payment
      if (existingOrder && existingOrder.step === "AWAITING_PAYMENT_VERIFICATION" && !existingOrder.isPaid) {
        if (lower.includes("paid") || lower.includes("done") || lower.includes("check") || lower.includes("status")) {
          console.log(`🔍 Checking payment status with Razorpay for Order ${existingOrder.orderId}...`);
          const apiVerified = await checkRazorpayApiPayment(existingOrder);
          if (apiVerified) {
            await handlePaymentSuccess(sender, existingOrder);
            return;
          }

          // If NOT verified yet, do NOT blindly confirm! Tell the user:
          await sendText(
            sender,
            `⏳ *Payment Not Received Yet*\n\n` +
            `We checked our system, but have not yet received payment of *₹${existingOrder.totalPayable}* for Order *${existingOrder.orderId}*.\n\n` +
            `Please tap your UPI app (Google Pay, PhonePe, Paytm) above to complete the payment.\n\n` +
            `_As soon as the payment is confirmed, we will automatically ask for your delivery location!_`
          );
          return;
        }
      }

      // Check if user is waiting to share location and typed text address (e.g. GPS disabled fallback)
      if (existingOrder && (existingOrder.step === "AWAITING_LOCATION" || existingOrder.step === "AWAITING_PAYMENT_VERIFICATION")) {
        existingOrder.location = { address: bodyText };

        // If online payment and not yet verified: DO NOT confirm order!
        if (existingOrder.paymentMethod?.includes("Online") && !existingOrder.isPaid) {
          await sendText(
            sender,
            `📍 *Delivery address saved!*\n\n` +
            `⚠️ *Payment Pending:* Your online payment of *₹${existingOrder.totalPayable}* for Order *${existingOrder.orderId}* is not yet received.\n\n` +
            `Please tap your UPI app (Google Pay, PhonePe, Paytm) above to complete payment. As soon as your payment is received, your order will be confirmed immediately!`
          );
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

// ─── Reusable Universal UPI Checkout Page Renderer ───────────────────────────
function renderUpiCheckoutHtml({ orderId, order, targetApp = null }) {
  const { upiId, merchantName, amount, upiUrl, qrCodeUrl, tr } = generateUpiDetails(order || { orderId, totalPayable: 1 });
  const note = `Order ${orderId}`;
  const baseQuery = `pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}&tr=${encodeURIComponent(tr || orderId.replace(/[^a-zA-Z0-9]/g, ""))}`;

  const universalUpi = `upi://pay?${baseQuery}`;
  const gpayUrl      = `tez://upi/pay?${baseQuery}`;
  const phonepeUrl   = `intent://pay?${baseQuery}#Intent;scheme=upi;package=com.phonepe.app;end`;
  const paytmUrl     = `intent://pay?${baseQuery}#Intent;scheme=upi;package=net.one97.paytm;end`;

  let primaryTarget = universalUpi;
  let primaryTitle  = "UPI App";
  let primaryEmoji  = "⚡";

  if (targetApp === "gpay") {
    primaryTarget = gpayUrl;
    primaryTitle  = "Google Pay";
    primaryEmoji  = "🟢";
  } else if (targetApp === "phonepe") {
    primaryTarget = phonepeUrl;
    primaryTitle  = "PhonePe";
    primaryEmoji  = "🟣";
  } else if (targetApp === "paytm") {
    primaryTarget = paytmUrl;
    primaryTitle  = "Paytm";
    primaryEmoji  = "🔵";
  }

  const shouldAutoLaunch = Boolean(targetApp);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Pay ₹${amount} - ${merchantName}</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f0f2f5;
      margin: 0;
      padding: 16px;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      color: #111b21;
    }
    .card {
      background: #ffffff;
      max-width: 420px;
      width: 100%;
      border-radius: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.08);
      overflow: hidden;
      text-align: center;
    }
    .header {
      background: linear-gradient(135deg, #075e54, #128c7e);
      color: white;
      padding: 24px 20px 20px;
    }
    .header h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }
    .header p {
      margin: 4px 0 0;
      font-size: 13px;
      opacity: 0.88;
    }
    .content {
      padding: 24px 20px;
    }
    .amount-badge {
      display: inline-block;
      background: #e7f8ee;
      color: #0b8043;
      font-size: 32px;
      font-weight: 800;
      padding: 8px 24px;
      border-radius: 999px;
      margin: 12px 0;
      letter-spacing: -0.5px;
    }
    .order-meta {
      font-size: 13px;
      color: #667781;
      margin-bottom: 20px;
    }
    .btn-main {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: #25d366;
      color: #ffffff;
      text-decoration: none;
      font-size: 17px;
      font-weight: 700;
      padding: 16px 24px;
      border-radius: 12px;
      box-shadow: 0 4px 14px rgba(37,211,102,0.35);
      transition: transform 0.1s ease, background 0.2s ease;
      margin-bottom: 12px;
    }
    .btn-main:active {
      transform: scale(0.98);
      background: #1eb956;
    }
    .btn-secondary {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: #f0f2f5;
      color: #111b21;
      text-decoration: none;
      font-size: 15px;
      font-weight: 600;
      padding: 13px 20px;
      border-radius: 12px;
      margin-bottom: 20px;
      border: 1px solid #e1e4e8;
    }
    .btn-secondary:active {
      background: #e4e6eb;
    }
    .divider {
      display: flex;
      align-items: center;
      text-align: center;
      color: #8696a0;
      font-size: 12px;
      margin: 18px 0;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      border-bottom: 1px solid #e1e4e8;
    }
    .divider:not(:empty)::before { margin-right: .8em; }
    .divider:not(:empty)::after { margin-left: .8em; }
    .app-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 10px;
      margin-bottom: 20px;
    }
    .app-pill {
      background: #f7f9fa;
      border: 1px solid #e9ecef;
      padding: 10px 8px;
      border-radius: 10px;
      text-decoration: none;
      color: #111b21;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    .app-pill:active { background: #e9ecef; }
    .upi-box {
      background: #f8fafc;
      border: 1px dashed #cbd5e1;
      border-radius: 12px;
      padding: 14px;
      margin: 16px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      text-align: left;
    }
    .upi-text {
      font-size: 13px;
      color: #334155;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .upi-text strong {
      display: block;
      color: #0f172a;
      font-size: 14px;
      font-family: monospace;
      margin-top: 2px;
    }
    .btn-copy {
      background: #075e54;
      color: white;
      border: none;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .qr-container {
      margin: 16px auto;
      padding: 12px;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      display: inline-block;
    }
    .qr-container img {
      width: 190px;
      height: 190px;
      display: block;
    }
    .toast {
      display: none;
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #111b21;
      color: white;
      padding: 10px 20px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      z-index: 9999;
    }
    .footer-hint {
      font-size: 12px;
      color: #8696a0;
      line-height: 1.5;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>${merchantName}</h1>
      <p>Secure UPI Payment Checkout</p>
    </div>

    <div class="content">
      <div class="order-meta">Order ID: <strong>#${orderId}</strong></div>
      <div class="amount-badge">₹${amount}</div>

      <!-- Primary Action Button -->
      <a id="btnPrimary" class="btn-main" href="${primaryTarget}">
        <span>${primaryEmoji}</span>
        <span>Open ${primaryTitle}</span>
      </a>

      <!-- Universal Fallback Button -->
      <a class="btn-secondary" href="${universalUpi}">
        <span>⚡</span>
        <span>Pay with Any UPI App</span>
      </a>

      <div class="divider">Or choose your app</div>

      <!-- Direct App Selector Grid -->
      <div class="app-grid">
        <a class="app-pill" href="${gpayUrl}">
          <span style="font-size: 18px;">🟢</span>
          <span>Google Pay</span>
        </a>
        <a class="app-pill" href="${phonepeUrl}">
          <span style="font-size: 18px;">🟣</span>
          <span>PhonePe</span>
        </a>
        <a class="app-pill" href="${paytmUrl}">
          <span style="font-size: 18px;">🔵</span>
          <span>Paytm</span>
        </a>
      </div>

      <!-- Copy UPI ID Box -->
      <div class="upi-box">
        <div class="upi-text">
          <span>Payee UPI ID:</span>
          <strong id="upiIdVal">${upiId}</strong>
        </div>
        <button class="btn-copy" onclick="copyUpi()">📋 Copy</button>
      </div>

      <!-- Dynamic QR Code for Scanning -->
      <div class="qr-container">
        <a href="${universalUpi}">
          <img src="${qrCodeUrl}" alt="UPI QR Code" />
        </a>
      </div>
      <div style="font-size: 12px; color: #667781; margin-top: -6px;">Tap QR code or scan with any UPI app</div>

      <div class="footer-hint">
        🔒 Powered by National Payments Corporation of India (NPCI)<br/>
        After paying, return to WhatsApp to confirm delivery details.
      </div>
    </div>
  </div>

  <div id="toast" class="toast">✅ UPI ID copied to clipboard!</div>

  <script>
    function copyUpi() {
      const upi = document.getElementById("upiIdVal").innerText.trim();
      navigator.clipboard.writeText(upi).then(function() {
        const toast = document.getElementById("toast");
        toast.style.display = "block";
        setTimeout(() => { toast.style.display = "none"; }, 2500);
      }).catch(function() {
        prompt("Copy UPI ID:", upi);
      });
    }

    ${shouldAutoLaunch ? `
    // Auto-launch selected app without race conditions or timer collisions
    window.addEventListener("DOMContentLoaded", function() {
      setTimeout(function() {
        try {
          window.location.href = "${primaryTarget}";
        } catch (_) {}
      }, 350);
    });
    ` : ""}
  </script>
</body>
</html>`;
}

// ─── Web Payment Checkout View (Browser preview / direct UPI link) ──────────
app.get("/pay/:orderId", async (req, res) => {
  const { orderId } = req.params;
  let order = Object.values(userOrders).find((o) => o.orderId === orderId);
  if (!order) {
    try {
      const doc = await Order.findOne({ orderId });
      if (doc) order = doc.toObject();
    } catch (_) {}
  }
  if (!order) {
    order = {
      orderId,
      totalPayable: 1,
      items: [{ name: "Playhaus Game", qty: 1, price: 1 }],
      deliveryFee: 0,
      itemsTotal: 1,
    };
  }

  res.send(renderUpiCheckoutHtml({ orderId, order, targetApp: null }));
});

// ─── Direct UPI App Redirects (Google Pay, PhonePe, Paytm, Universal UPI) ─────
app.get("/pay/:app/:orderId", async (req, res) => {
  const { app: appName, orderId } = req.params;
  let order = Object.values(userOrders).find((o) => o.orderId === orderId);
  if (!order) {
    try {
      const doc = await Order.findOne({ orderId });
      if (doc) order = doc.toObject();
    } catch (_) {}
  }
  if (!order) {
    order = {
      orderId,
      totalPayable: 1,
    };
  }

  res.send(renderUpiCheckoutHtml({ orderId, order, targetApp: appName }));
});

// ─── Razorpay Webhook Endpoint ────────────────────────────────────────────────
app.post(["/razorpay-webhook", "/webhook/razorpay"], async (req, res) => {
  const event = req.body?.event;
  const payment = req.body?.payload?.payment?.entity;
  console.log("⚡ Razorpay Webhook received:", event, payment?.id, payment?.amount);

  if (event === "payment.captured" || event === "order.paid") {
    const noteOrderId = payment?.notes?.order_id || payment?.description;
    let matched = false;

    for (const [phone, order] of Object.entries(userOrders)) {
      if (!order.isPaid && ((noteOrderId && order.orderId.includes(noteOrderId)) || order.step === "AWAITING_PAYMENT_VERIFICATION")) {
        console.log(`✅ Order ${order.orderId} marked paid via Razorpay webhook.`);
        await handlePaymentSuccess(phone, order);
        matched = true;
        break;
      }
    }

    // Also check MongoDB Atlas if order was created across restart
    if (!matched && noteOrderId) {
      try {
        const dbOrder = await Order.findOne({ orderId: { $regex: noteOrderId, $options: "i" }, isPaid: false });
        if (dbOrder) {
          console.log(`✅ MongoDB Order ${dbOrder.orderId} marked paid via Razorpay webhook.`);
          const orderObj = dbOrder.toObject();
          await handlePaymentSuccess(orderObj.sender, orderObj);
        }
      } catch (err) {
        console.error("MongoDB webhook match error:", err.message);
      }
    }
  }
  res.json({ status: "ok" });
});

// ─── Test / Simulation Endpoint to Trigger Payment Done ───────────────────────
app.all("/api/payment/simulate/:orderId", async (req, res) => {
  const { orderId } = req.params;
  for (const [phone, order] of Object.entries(userOrders)) {
    if (order.orderId === orderId || !order.isPaid) {
      await handlePaymentSuccess(phone, order);
      return res.json({ success: true, message: `Payment simulated for order ${order.orderId}` });
    }
  }

  // Check MongoDB
  try {
    const dbOrder = await Order.findOne({ orderId });
    if (dbOrder) {
      const orderObj = dbOrder.toObject();
      await handlePaymentSuccess(orderObj.sender, orderObj);
      return res.json({ success: true, message: `Payment simulated for MongoDB order ${orderObj.orderId}` });
    }
  } catch (_) {}

  res.status(404).json({ error: "Order not found" });
});

// ─── API to View Persisted Orders from MongoDB ────────────────────────────────
app.get("/api/orders", async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).limit(100);
    res.json({ count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders/:orderId", async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API to Update Order Status (Admin / Logistics) ───────────────────────────
app.post("/api/orders/:orderId/status", async (req, res) => {
  const { orderId } = req.params;
  const { step, trackingNumber, courier, trackingUrl, statusUpdate, notifyCustomer } = req.body;
  try {
    const updateDoc = {};
    if (step) updateDoc.step = step;
    if (trackingNumber !== undefined) updateDoc.trackingNumber = trackingNumber;
    if (courier !== undefined) updateDoc.courier = courier;
    if (trackingUrl !== undefined) updateDoc.trackingUrl = trackingUrl;
    if (statusUpdate !== undefined) updateDoc.statusUpdate = statusUpdate;

    const order = await Order.findOneAndUpdate(
      { orderId },
      { $set: updateDoc },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Update in-memory cache if active
    if (userOrders[order.sender]) {
      userOrders[order.sender] = { ...userOrders[order.sender], ...order.toObject() };
    }

    // Optionally notify customer on WhatsApp
    if (notifyCustomer && order.sender) {
      await sendOrderTrackingCard(order.sender, order.toObject());
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API to View Customer Support Tickets from MongoDB ────────────────────────
app.get("/api/support-tickets", async (req, res) => {
  try {
    const tickets = await SupportTicket.find().sort({ createdAt: -1 }).limit(100);
    res.json({ count: tickets.length, tickets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Web Order Tracking View (Browser preview / shareable tracking page) ─────
app.get("/track/:orderId", async (req, res) => {
  const { orderId } = req.params;
  let order = await findOrderByIdOrSender(orderId, null);
  if (!order) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Order Not Found - Playhaus Games</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; margin: 0; padding: 24px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: white; max-width: 440px; width: 100%; border-radius: 20px; box-shadow: 0 8px 30px rgba(0,0,0,0.06); padding: 32px 24px; text-align: center; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h2 { margin: 0 0 8px; color: #111b21; }
    p { color: #667781; font-size: 14px; margin: 0 0 24px; line-height: 1.5; }
    .btn { display: inline-block; background: #075e54; color: white; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: 600; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔍</div>
    <h2>Order Not Found</h2>
    <p>We couldn't find an order with ID <strong>#${orderId}</strong>. Please check the order number or contact our support team.</p>
    <a class="btn" href="https://wa.me/916364936004?text=Hi%2C%20I%20need%20help%20tracking%20my%20order">💬 Contact Support</a>
  </div>
</body>
</html>`);
  }

  const dateStr = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Recently placed";

  let stepIndex = 1;
  let statusBadge = "Confirmed & Preparing for Dispatch 📦";
  let statusDesc = "Our team is packing your Playhaus games for courier pickup.";

  if (order.step === "AWAITING_PAYMENT") {
    stepIndex = 0;
    statusBadge = "Payment Pending ⏳";
    statusDesc = "Please complete your payment to proceed with dispatch.";
  } else if (order.step === "AWAITING_LOCATION") {
    stepIndex = 1;
    statusBadge = "Waiting for Address 📍";
    statusDesc = "Payment received! Please share your delivery address on WhatsApp.";
  } else if (order.step === "SHIPPED") {
    stepIndex = 2;
    statusBadge = "In Transit 🚚";
    statusDesc = `Your parcel has been handed over to ${order.courier || "Delhivery"}.`;
  } else if (order.step === "OUT_FOR_DELIVERY") {
    stepIndex = 2;
    statusBadge = "Out for Delivery 🛵";
    statusDesc = "Your order will be delivered to your doorstep today!";
  } else if (order.step === "DELIVERED") {
    stepIndex = 3;
    statusBadge = "Delivered 🎉";
    statusDesc = "Your order was successfully delivered. Happy playing!";
  }

  const itemsHtml = (order.items || [])
    .map(
      (it) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f0f2f5;">
      <div>
        <div style="font-weight:600; font-size:14px; color:#111b21;">${it.name}</div>
        <div style="font-size:12px; color:#667781;">Qty: ${it.qty || 1}</div>
      </div>
      <div style="font-weight:700; font-size:14px; color:#0b8043;">₹${Number(it.price || 1) * Number(it.qty || 1)}</div>
    </div>`
    )
    .join("");

  const addressText = order.location?.address || (order.location ? "Live GPS Location saved" : "Pending location");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Track Order #${order.orderId} - Playhaus Games</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; margin: 0; padding: 16px; display: flex; justify-content: center; }
    .card { background: white; max-width: 480px; width: 100%; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.06); overflow: hidden; }
    .header { background: linear-gradient(135deg, #075e54, #128c7e); color: white; padding: 24px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 700; }
    .header p { margin: 4px 0 0; font-size: 13px; opacity: 0.9; }
    .content { padding: 24px 20px; }
    .status-card { background: #e7f8ee; border-radius: 14px; padding: 16px; margin-bottom: 24px; text-align: center; }
    .status-badge { display: inline-block; font-size: 15px; font-weight: 800; color: #0b8043; margin-bottom: 6px; }
    .status-desc { font-size: 13px; color: #334155; margin: 0; }
    .stepper { display: flex; justify-content: space-between; position: relative; margin: 28px 0 32px; }
    .stepper::before { content: ''; position: absolute; top: 16px; left: 24px; right: 24px; height: 3px; background: #e2e8f0; z-index: 1; }
    .step { position: relative; z-index: 2; text-align: center; width: 25%; }
    .step-circle { width: 32px; height: 32px; border-radius: 50%; background: #e2e8f0; color: #64748b; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; margin: 0 auto 8px; }
    .step.active .step-circle { background: #075e54; color: white; box-shadow: 0 0 0 4px #e7f8ee; }
    .step.done .step-circle { background: #25d366; color: white; }
    .step-label { font-size: 11px; font-weight: 600; color: #64748b; }
    .step.active .step-label { color: #075e54; font-weight: 700; }
    .box { background: #f8fafc; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .box-title { font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
    .btn-wa { display: flex; align-items: center; justify-content: center; gap: 8px; background: #25d366; color: white; text-decoration: none; padding: 14px 20px; border-radius: 12px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 14px rgba(37,211,102,0.35); margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Playhaus Games</h1>
      <p>Order Tracking Portal</p>
    </div>
    <div class="content">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <div>
          <div style="font-size:12px; color:#64748b;">Order Number</div>
          <div style="font-size:18px; font-weight:800; color:#111b21;">#${order.orderId}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px; color:#64748b;">Date Placed</div>
          <div style="font-size:13px; font-weight:600; color:#111b21;">${dateStr}</div>
        </div>
      </div>

      <div class="status-card">
        <div class="status-badge">${statusBadge}</div>
        <p class="status-desc">${statusDesc}</p>
        ${order.trackingNumber ? `<div style="font-size:12px; font-weight:600; margin-top:8px; color:#0f172a;">Courier: ${order.courier || "Delhivery"} • AWB: ${order.trackingNumber}</div>` : ""}
      </div>

      <!-- Visual Step Progress -->
      <div class="stepper">
        <div class="step ${stepIndex >= 0 ? (stepIndex > 0 ? "done" : "active") : ""}">
          <div class="step-circle">${stepIndex > 0 ? "✓" : "1"}</div>
          <div class="step-label">Placed</div>
        </div>
        <div class="step ${stepIndex >= 1 ? (stepIndex > 1 ? "done" : "active") : ""}">
          <div class="step-circle">${stepIndex > 1 ? "✓" : "2"}</div>
          <div class="step-label">Confirmed</div>
        </div>
        <div class="step ${stepIndex >= 2 ? (stepIndex > 2 ? "done" : "active") : ""}">
          <div class="step-circle">${stepIndex > 2 ? "✓" : "3"}</div>
          <div class="step-label">Shipped</div>
        </div>
        <div class="step ${stepIndex >= 3 ? "active done" : ""}">
          <div class="step-circle">4</div>
          <div class="step-label">Delivered</div>
        </div>
      </div>

      <!-- Items Ordered -->
      <div class="box">
        <div class="box-title">Items Ordered</div>
        ${itemsHtml}
        <div style="display:flex; justify-content:space-between; margin-top:12px; padding-top:10px; border-top:1px dashed #cbd5e1; font-weight:700;">
          <span>Total Paid</span>
          <span style="color:#0b8043;">₹${order.totalPayable}</span>
        </div>
      </div>

      <!-- Delivery Address -->
      <div class="box">
        <div class="box-title">Delivery Details</div>
        <div style="font-size:13px; color:#1e293b; line-height:1.5;">${addressText}</div>
        <div style="font-size:12px; color:#64748b; margin-top:6px;">Expected by: <strong>${order.expectedDelivery || "Within 3–5 business days"}</strong></div>
      </div>

      <a class="btn-wa" href="https://wa.me/916364936004?text=Hi%2C%20I%20have%20a%20question%20about%20Order%20${order.orderId}">
        💬 Chat with Customer Support
      </a>
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
    database: {
      type: "MongoDB Atlas",
      connected: mongoose.connection.readyState === 1,
      database: mongoose.connection.name || "playhaus",
      cluster: "cluster0.rytjyvn.mongodb.net",
    },
    webhook: {
      url: "https://playhaus.onrender.com/webhook",
      subscribed: true,
      fields: ["messages"],
    },
    razorpay: {
      account_id: process.env.RAZORPAY_ACCOUNT_ID || "acc_Rl7A6E91g4TV40",
      configuration_name: process.env.RAZORPAY_CONFIG_NAME || "devine",
      status: "Active",
      upi_id: process.env.RAZORPAY_UPI_ID || "8801414663@ybl",
      merchant_name: process.env.RAZORPAY_MERCHANT_NAME || "vijay g",
    },
  });
});

app.get("/", (req, res) => res.status(200).send("WhatsApp bot is running 🟢"));

const primaryPort = Number(process.env.PORT) || 10000;

app.listen(primaryPort, "0.0.0.0", () => {
  console.log(`🚀 Bot server started on port ${primaryPort} (0.0.0.0)`);
});

// Dual-port listening: Also listen on port 3000 if primary port is 10000 (or vice versa)
// Guarantees that whether Render probes 10000 or 3000, it receives an immediate response
const secondaryPort = primaryPort === 10000 ? 3000 : 10000;
try {
  app.listen(secondaryPort, "0.0.0.0", () => {
    console.log(`🚀 Secondary listener active on port ${secondaryPort} (0.0.0.0)`);
  });
} catch (_) {}
