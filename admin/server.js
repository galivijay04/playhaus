require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express  = require("express");
const multer   = require("multer");
const fs       = require("fs");
const path     = require("path");
const { execSync } = require("child_process");

const app         = express();
const CONFIG_PATH = path.join(__dirname, "../config.json");
const UPLOAD_DIR  = path.join(__dirname, "uploads");
const ADMIN_PORT  = process.env.ADMIN_PORT || 4000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `banner_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"));
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readConfig()      { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
function writeConfig(data) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf8"); }

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/config", (req, res) => res.json(readConfig()));

app.post("/api/config/welcome", (req, res) => {
  const cfg = readConfig();
  const allowed = [
    "welcomeMessage", "welcomeBannerCaption",
    "flowBodyText", "flowCtaText", "flowFooterText",
    "flowCompletionReply", "trackOrderReply", "supportReply",
  ];
  allowed.forEach((key) => { if (req.body[key] !== undefined) cfg[key] = req.body[key]; });
  writeConfig(cfg);
  res.json({ success: true, config: cfg });
});

app.post("/api/config/banner", upload.single("banner"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const cfg     = readConfig();
  const baseUrl = process.env.PUBLIC_URL || "http://localhost:3000";
  cfg.welcomeBannerUrl = `${baseUrl}/uploads/${req.file.filename}`;
  writeConfig(cfg);
  res.json({ success: true, bannerUrl: cfg.welcomeBannerUrl });
});

app.delete("/api/config/banner", (req, res) => {
  const cfg = readConfig();
  cfg.welcomeBannerUrl = "";
  writeConfig(cfg);
  res.json({ success: true });
});

app.post("/api/config/banner-url", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const cfg = readConfig();
  cfg.welcomeBannerUrl = url;
  writeConfig(cfg);
  res.json({ success: true, bannerUrl: cfg.welcomeBannerUrl });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PRODUCT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/products", (req, res) => res.json(readConfig().products || []));

app.post("/api/products", (req, res) => {
  const { name, flowId, description, price, tags, imageUrl, productUrl } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const cfg     = readConfig();
  const product = {
    id:          Date.now().toString(),
    flowId:      flowId || name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""),
    name,
    description: description || "",
    price:       price       || "",
    tags:        tags        || "",
    imageUrl:    imageUrl    || "",
    productUrl:  productUrl  || "",
    active:      true,
    createdAt:   new Date().toISOString(),
  };
  cfg.products.push(product);
  writeConfig(cfg);
  res.json({ success: true, product });
});

app.put("/api/products/:id", (req, res) => {
  const cfg = readConfig();
  const idx = cfg.products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Product not found" });
  cfg.products[idx] = { ...cfg.products[idx], ...req.body };
  writeConfig(cfg);
  res.json({ success: true, product: cfg.products[idx] });
});

app.delete("/api/products/:id", (req, res) => {
  const cfg = readConfig();
  cfg.products = cfg.products.filter((p) => p.id !== req.params.id);
  writeConfig(cfg);
  res.json({ success: true });
});

// ─── Regenerate flow.json from products ──────────────────────────────────────
app.post("/api/regenerate-flow", (req, res) => {
  try {
    const scriptPath = path.join(__dirname, "../generate-flow.js");
    execSync(`node "${scriptPath}"`, { cwd: path.join(__dirname, ".."), timeout: 60000 });
    res.json({ success: true });
  } catch (err) {
    console.error("Regenerate flow error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(ADMIN_PORT, () => {
  console.log(`🛠️  Admin panel running at http://localhost:${ADMIN_PORT}`);
});
