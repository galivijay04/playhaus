const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ─── Product list — must match config.json ────────────────────────────────────
const products = [
  {
    id:          "snap_magnet",
    name:        "Snap Magnet",
    price:       "Rs.999",
    tags:        "Strategy • Ages 5+ • 2+ Players",
    description: "Roll the dice, place magnets carefully on the board. If they snap together you lose them! 2 themes: Galaxy & Ocean Reef.",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-snap-magnet-3_100x100_crop_center.webp?v=1785878825",
  },
  {
    id:          "slam_10",
    name:        "Slam 10",
    price:       "Rs.999",
    tags:        "Trivia + Math • Ages 5+ • 2-6 Players",
    description: "Answer trivia, earn the card, use the number to build your sequence from 1 to 10. First to complete wins!",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-lifestyle-slam10-1_100x100_crop_center.webp",
  },
  {
    id:          "hop_it",
    name:        "Hop-It",
    price:       "Rs.999",
    tags:        "Puzzle • Ages 6+ • Solo • 50+ Levels",
    description: "Build a pattern from the level book, then hop marbles across the board. End with just one marble left!",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/thumbnail-hopit.webp",
  },
  {
    id:          "bridgit_word_bridge",
    name:        "Bridgit: Word Bridge",
    price:       "Rs.999",
    tags:        "Vocabulary • Ages 8+ • 2 Players",
    description: "Arrange letter carriages behind your engine to spell a word matching the challenge. Shout 'All Aboard!' to win!",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-bridgit-english-1_100x100_crop_center.webp",
  },
  {
    id:          "color_match",
    name:        "Color Match",
    price:       "Rs.999",
    tags:        "Tactics • Ages 6+ • 2+ Players",
    description: "Build the longest chain of your goal color while blocking opponents. Use power cards to replace, vanish or cancel moves!",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-lifestyle-color-match-1_100x100_crop_center.webp",
  },
];

// ─── Fetch URL helper ─────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  ()  => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {

  // ── Download & base64 encode all product thumbnails ───────────────────────
  console.log("Downloading product thumbnails...");
  for (const p of products) {
    const buf = await fetchUrl(p.imageUrl);
    p.imageBase64 = buf.toString("base64");
    console.log(`  ${p.id}: ${(buf.length / 1024).toFixed(1)}KB`);
  }

  // ── Build radio data-source for CHOOSE_PRODUCT screen ────────────────────
  const productRadioSource = products.map((p) => ({
    id:    p.id,
    title: `${p.name} - ${p.price}`,
    image: p.imageBase64,
  }));

  // ── Build the 4-screen flow ───────────────────────────────────────────────
  const flow = {
    version: "5.1",
    screens: [

      // ══════════════════════════════════════════════
      // SCREEN 1 — Choose Service
      // ══════════════════════════════════════════════
      {
        id:    "CHOOSE_SERVICE",
        title: "Playhaus Services",
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Welcome to Playhaus 🎮" },
            { type: "TextBody",    text: "How can we help you today?" },
            {
              type: "RadioButtonsGroup",
              name: "service",
              label: "Select Service",
              required: true,
              "data-source": [
                { id: "place_order",      title: "🛍️ Place Order"      },
                { id: "track_order",      title: "📦 Track Order"      },
                { id: "customer_support", title: "🎧 Customer Support" },
              ],
            },
            {
              type:  "Footer",
              label: "Continue",
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: "CHOOSE_PRODUCT" },
                payload: { service: "${form.service}" },
              },
            },
          ],
        },
      },

      // ══════════════════════════════════════════════
      // SCREEN 2 — Choose Product
      // ══════════════════════════════════════════════
      {
        id:    "CHOOSE_PRODUCT",
        title: "Our Games",
        data: {
          service: { type: "string", "__example__": "place_order" },
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Select a Product 🛍️" },
            { type: "TextBody",    text: "Tap a game below to view details." },
            {
              type:     "RadioButtonsGroup",
              name:     "product",
              label:    "Our Games",
              required: true,
              "data-source": productRadioSource,
            },
            {
              type:  "Footer",
              label: "View Details",
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: "PRODUCT_DETAIL" },
                payload: {
                  service: "${data.service}",
                  product: "${form.product}",
                },
              },
            },
          ],
        },
      },

      // ══════════════════════════════════════════════
      // SCREEN 3 — Product Detail
      // Shows product image, name, price, description,
      // tags + "Add to Cart" button
      // ══════════════════════════════════════════════
      {
        id:    "PRODUCT_DETAIL",
        title: "Product Details",
        data: {
          service: { type: "string", "__example__": "place_order"  },
          product: { type: "string", "__example__": "snap_magnet"  },
        },
        layout: {
          type: "SingleColumnLayout",
          children: [

            // Product image (full-width) using the first product as example
            {
              type:      "Image",
              src:       products[0].imageBase64,
              width:     300,
              height:    300,
              "scale-type": "contain",
              "aspect-ratio": 1,
              "alt-text": "Product Image",
            },

            { type: "TextHeading",    text: "Snap Magnet"                       },
            { type: "TextSubheading", text: "Rs.999"                            },
            {
              type: "TextBody",
              text: "Roll the dice, place magnets carefully on the board. If they snap together you lose them! 2 themes: Galaxy & Ocean Reef.",
            },
            {
              type: "TextCaption",
              text: "#Strategy #MagnetGame #FamilyPlay #Ages5Plus",
            },

            {
              type:  "Footer",
              label: "Add to Cart 🛒",
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: "CART" },
                payload: {
                  service: "${data.service}",
                  product: "${data.product}",
                },
              },
            },
          ],
        },
      },

      // ══════════════════════════════════════════════
      // SCREEN 4 — Cart (Quantity Selector)
      // ══════════════════════════════════════════════
      {
        id:       "CART",
        title:    "Your Cart",
        terminal: true,
        data: {
          service: { type: "string", "__example__": "place_order" },
          product: { type: "string", "__example__": "snap_magnet" },
        },
        layout: {
          type: "SingleColumnLayout",
          children: [

            { type: "TextHeading", text: "🛒 Your Cart"                    },
            { type: "TextBody",    text: "Review your order before placing it." },

            // Product summary box
            {
              type: "TextSubheading",
              text: "Selected Game",
            },
            {
              type: "TextBody",
              text: "Snap Magnet\nRs.999 per unit",
            },

            // Quantity input
            {
              type:        "TextInput",
              name:        "quantity",
              label:       "Quantity",
              "input-type": "number",
              required:    true,
              "min-chars": 1,
              "max-chars": 2,
              "init-value": "1",
              "helper-text": "Enter quantity (1–99)",
            },

            // Special instructions
            {
              type:        "TextInput",
              name:        "special_note",
              label:       "Special Instructions (optional)",
              "input-type": "text",
              required:    false,
              "helper-text": "e.g. Gift wrap, delivery note",
            },

            {
              type:  "Footer",
              label: "Place Order ✅",
              "on-click-action": {
                name: "complete",
                payload: {
                  service:      "${data.service}",
                  product:      "${data.product}",
                  quantity:     "${form.quantity}",
                  special_note: "${form.special_note}",
                },
              },
            },
          ],
        },
      },

    ],
  };

  // ── Write flow.json ───────────────────────────────────────────────────────
  const outPath = path.join(__dirname, "flow.json");
  fs.writeFileSync(outPath, JSON.stringify(flow, null, 2), "utf8");

  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\n✅ flow.json written — ${sizeKB} KB`);
  console.log("Screens:", flow.screens.map(s => s.id).join(" → "));
}

main().catch((err) => { console.error(err); process.exit(1); });
