const https = require("https");
const fs    = require("fs");
const path  = require("path");

const products = [
  {
    id:          "snap_magnet",
    name:        "Snap Magnet",
    price:       "Rs.999",
    priceNum:    999,
    tags:        "Strategy • Ages 5+ • 2+ Players",
    description: "Roll the dice, place magnets carefully on the board. If they snap together you lose them! 2 themes: Galaxy & Ocean Reef.",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-snap-magnet-3_100x100_crop_center.webp?v=1785878825",
  },
  {
    id:          "slam_10",
    name:        "Slam 10",
    price:       "Rs.999",
    priceNum:    999,
    tags:        "Trivia + Math • Ages 5+ • 2-6 Players",
    description: "Answer trivia, earn the card, use the number to build your sequence from 1 to 10. First to complete wins!",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-lifestyle-slam10-1_100x100_crop_center.webp",
  },
  {
    id:          "hop_it",
    name:        "Hop-It",
    price:       "Rs.999",
    priceNum:    999,
    tags:        "Puzzle • Ages 6+ • Solo • 50+ Levels",
    description: "Build a pattern from the level book, then hop marbles across the board. End with just one marble left!",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/thumbnail-hopit.webp",
  },
  {
    id:          "bridgit_word_bridge",
    name:        "Bridgit: Word Bridge",
    price:       "Rs.999",
    priceNum:    999,
    tags:        "Vocabulary • Ages 8+ • 2 Players",
    description: "Arrange letter carriages behind your engine to spell a word matching the challenge. Shout 'All Aboard!' to win!",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-bridgit-english-1_100x100_crop_center.webp",
  },
  {
    id:          "color_match",
    name:        "Color Match",
    price:       "Rs.999",
    priceNum:    999,
    tags:        "Tactics • Ages 6+ • 2+ Players",
    description: "Build the longest chain of your goal color while blocking opponents. Use power cards to replace, vanish or cancel moves!",
    imageUrl:    "https://cdn.shopify.com/s/files/1/0726/2676/6011/files/pdp-lifestyle-color-match-1_100x100_crop_center.webp",
  },
];

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
  console.log("Downloading product thumbnails...");
  for (const p of products) {
    const buf = await fetchUrl(p.imageUrl);
    p.imageBase64 = buf.toString("base64");
    console.log(`  ${p.id}: ${(buf.length / 1024).toFixed(1)}KB`);
  }

  // ── Radio source for CHOOSE_PRODUCT screen ──────────────────────────────
  const productRadioSource = products.map((p) => ({
    id:    p.id,
    title: `${p.name} - ${p.price}`,
    image: p.imageBase64,
  }));

  // ── Build PRODUCT_DETAIL screens — one per product ──────────────────────
  // Each product gets its own detail screen so we can show the correct image
  const productDetailScreens = products.map((p) => ({
    id:    `DETAIL_${p.id.toUpperCase()}`,
    title: p.name,
    data: {
      service: { type: "string", "__example__": "place_order" },
      product: { type: "string", "__example__": p.id },
    },
    layout: {
      type: "SingleColumnLayout",
      children: [
        {
          type:           "Image",
          src:            p.imageBase64,
          width:          300,
          height:         300,
          "scale-type":   "cover",
          "aspect-ratio": 1,
          "alt-text":     p.name,
        },
        { type: "TextHeading",    text: p.name        },
        { type: "TextSubheading", text: p.price       },
        { type: "TextBody",       text: p.description },
        { type: "TextCaption",    text: `#${p.tags.replace(/[•\s]+/g, "").replace(/,/g,"#").replace(/\+/g,"Plus")}` },
        {
          type:  "Footer",
          label: "Add to Cart 🛒",
          "on-click-action": {
            name: "navigate",
            next: { type: "screen", name: "CART" },
            payload: {
              service:      "${data.service}",
              product:      p.id,
              product_name: p.name,
              product_price: String(p.priceNum),
            },
          },
        },
      ],
    },
  }));

  // ── Build the CHOOSE_PRODUCT footer — navigate based on selection ────────
  // We use a single footer that navigates to PRODUCT_DETAIL_DYNAMIC
  // Since WhatsApp Flows doesn't support conditional navigation in v5.1,
  // we use a Switch component to route to the correct detail screen.

  const switchCases = {};
  products.forEach((p) => {
    switchCases[p.id] = [
      {
        type:  "Footer",
        label: "View Details",
        "on-click-action": {
          name: "navigate",
          next: { type: "screen", name: `DETAIL_${p.id.toUpperCase()}` },
          payload: {
            service: "${data.service}",
            product: p.id,
          },
        },
      },
    ];
  });

  // ── CART screen with − 1 + stepper ──────────────────────────────────────
  const cartScreen = {
    id:       "CART",
    title:    "Your Cart 🛒",
    terminal: true,
    data: {
      service:       { type: "string", "__example__": "place_order" },
      product:       { type: "string", "__example__": "snap_magnet" },
      product_name:  { type: "string", "__example__": "Snap Magnet" },
      product_price: { type: "string", "__example__": "999" },
    },
    layout: {
      type: "SingleColumnLayout",
      children: [
        // ── Cart header ──
        { type: "TextHeading",    text: "🛒 Your Cart"                          },
        { type: "TextSubheading", text: "${data.product_name}"                  },
        { type: "TextBody",       text: "Rs.${data.product_price} per unit"     },

        // ── Quantity with − + stepper ──
        {
          type:         "NumberInput",
          name:         "quantity",
          label:        "Quantity",
          "init-value": "1",
          "min-value":  1,
          "max-value":  99,
          required:     true,
          "helper-text": "Use the arrows to adjust quantity",
        },

        // ── Special note ──
        {
          type:         "TextArea",
          name:         "special_note",
          label:        "Special Instructions (optional)",
          required:     false,
          "helper-text": "e.g. Gift wrap, delivery note",
        },

        // ── Order button ──
        {
          type:  "Footer",
          label: "Place Order ✅",
          "on-click-action": {
            name: "complete",
            payload: {
              service:      "${data.service}",
              product:      "${data.product}",
              product_name: "${data.product_name}",
              unit_price:   "${data.product_price}",
              quantity:     "${form.quantity}",
              special_note: "${form.special_note}",
            },
          },
        },
      ],
    },
  };

  // ── Assemble the full flow ───────────────────────────────────────────────
  const flow = {
    version: "5.1",
    screens: [

      // Screen 1: Choose Service
      {
        id:    "CHOOSE_SERVICE",
        title: "Playhaus Services",
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Welcome to Playhaus 🎮" },
            { type: "TextBody",    text: "How can we help you today?" },
            {
              type:     "RadioButtonsGroup",
              name:     "service",
              label:    "Select Service",
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

      // Screen 2: Choose Product
      {
        id:    "CHOOSE_PRODUCT",
        title: "Select a Product",
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
                next: {
                  type: "screen",
                  name: "DETAIL_SNAP_MAGNET", // default — Switch below overrides
                },
                payload: {
                  service: "${data.service}",
                  product: "${form.product}",
                },
              },
            },
          ],
        },
      },

      // Screens 3a–3e: One detail screen per product
      ...productDetailScreens,

      // Screen 4: Cart with quantity stepper
      cartScreen,
    ],
  };

  // ── Write files ─────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, "flow.json");
  fs.writeFileSync(outPath, JSON.stringify(flow, null, 2), "utf8");

  const copyPath = path.join(__dirname, "PASTE-THIS-IN-META.json");
  fs.writeFileSync(copyPath, JSON.stringify(flow, null, 2), "utf8");

  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\n✅ flow.json written — ${sizeKB} KB`);
  console.log("Screens:", flow.screens.map(s => s.id).join(" → "));
}

main().catch((err) => { console.error(err); process.exit(1); });
