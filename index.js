require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const mongoose = require("mongoose");
const Order    = require("./models/Order");
const UserSession = require("./models/UserSession");

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

const { ACCESS_TOKEN, PHONE_NUMBER_ID, WEBHOOK_VERIFY_TOKEN, PORT = 3000, CATALOG_ID = "2192111105021785" } = process.env;
const GRAPH_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
const CONFIG_PATH   = path.join(__dirname, "config.json");
const FLOW_PATH     = path.join(__dirname, "flow.json");
const FLOW_ID       = "1090157514003637";
const userCarts     = {};
const userOrders    = {};

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
    };

    await Order.findOneAndUpdate(
      { orderId: order.orderId },
      { $set: orderDoc },
      { upsert: true, returnDocument: "after" }
    );
    console.log(`💾 Order ${order.orderId} synced to MongoDB Atlas.`);
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

      // Directly display the native shopping cart without intermediate text message
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
    await syncOrderToDb(sender, userOrders[sender]);

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
        const existingOrder = userOrders[sender] || {
          orderId: `PH-B2C-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
          totalPayable: 1,
        };
        await sendAppPaymentLauncher(sender, existingOrder, appChoice);
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

    // ── Interactive List Reply (e.g. UPI App Selection) ───────────────────
    if (type === "interactive" && msg.interactive?.type === "list_reply") {
      const listId = msg.interactive.list_reply?.id;
      console.log("📋 List reply clicked:", listId);

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

      const existingOrder = userOrders[sender];
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

      // Check if user is waiting to choose payment and typed text
      const existingOrder = userOrders[sender];
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

  const { upiId, merchantName, amount } = generateUpiDetails(order);
  const note = `Order ${orderId}`;
  const baseUpi = `pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;

  let deepLink = `upi://pay?${baseUpi}`;
  let appTitle = "UPI App";

  if (appName === "gpay") {
    deepLink = `tez://upi/pay?${baseUpi}`;
    appTitle = "Google Pay";
  } else if (appName === "phonepe") {
    deepLink = `phonepe://pay?${baseUpi}`;
    appTitle = "PhonePe";
  } else if (appName === "paytm") {
    deepLink = `paytmmp://pay?${baseUpi}`;
    appTitle = "Paytm";
  } else if (appName === "upi") {
    deepLink = `upi://pay?${baseUpi}`;
    appTitle = "UPI App";
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Opening ${appTitle}...</title>
  <meta http-equiv="refresh" content="0;url=${deepLink}">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .box { background: white; padding: 32px 24px; border-radius: 16px; text-align: center; max-width: 380px; width: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    .btn { display: block; background: #075e54; color: white; text-decoration: none; padding: 14px 24px; border-radius: 10px; font-weight: bold; margin-top: 24px; font-size: 16px; }
    .btn:hover { background: #128c7e; }
  </style>
  <script>
    // Instantly launch target UPI app
    window.location.href = "${deepLink}";
    setTimeout(function() {
      // Fallback to standard upi:// if specific app is not installed
      window.location.href = "upi://pay?${baseUpi}";
    }, 1500);
  </script>
</head>
<body>
  <div class="box">
    <h3 style="margin: 0 0 8px;">Opening ${appTitle}...</h3>
    <p style="color: #667781; font-size: 14px; margin: 0 0 16px;">Paying ₹${amount} for Order <strong>${orderId}</strong></p>
    <a class="btn" href="${deepLink}">👉 Open ${appTitle}</a>
    <p style="color: #888; font-size: 12px; margin-top: 20px; line-height: 1.5;">After paying, return to WhatsApp to provide your delivery address.</p>
  </div>
</body>
</html>`);
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
      upi_id: process.env.RAZORPAY_UPI_ID || "devine@razorpay",
      merchant_name: process.env.RAZORPAY_MERCHANT_NAME || "Devine Food Products",
    },
  });
});

app.get("/", (req, res) => res.send("WhatsApp bot is running 🟢"));

app.listen(PORT, () => {
  console.log(`🚀 Bot server started on port ${PORT}`);
});
