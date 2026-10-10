// ── Tab navigation ────────────────────────────────────────────────────────────
const TITLES = {
  welcome: "Welcome Message", banner: "Banner",
  flow: "Flow Settings", products: "Products", flowjson: "Flow JSON",
};

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    const tab = item.dataset.tab;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((t) => t.classList.remove("active"));
    item.classList.add("active");
    document.getElementById(`tab-${tab}`).classList.add("active");
    document.getElementById("page-title").textContent = TITLES[tab];
    if (tab === "flowjson") loadFlowJson();
    if (tab === "products") loadProducts();
  });
});

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { el.className = "toast"; }, 3000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function val(id)         { return document.getElementById(id)?.value || ""; }
function setText(id, v)  { const el = document.getElementById(id); if (el) el.textContent = v || ""; }
function setVal(id, v)   { const el = document.getElementById(id); if (el) el.value = v || ""; }
function show(id, vis)   { const el = document.getElementById(id); if (el) el.style.display = vis ? "" : "none"; }

async function apiPost(url, body) {
  const res  = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    populateForm(cfg);
    updateWelcomePreview(cfg);
  } catch (e) { toast("❌ Failed to load config", true); }
}

function populateForm(cfg) {
  setVal("welcomeMessage",       cfg.welcomeMessage);
  setVal("welcomeBannerCaption", cfg.welcomeBannerCaption);
  setVal("flowBodyText",         cfg.flowBodyText);
  setVal("flowCtaText",          cfg.flowCtaText);
  setVal("flowFooterText",       cfg.flowFooterText);
  setVal("trackOrderReply",      cfg.trackOrderReply);
  setVal("supportReply",         cfg.supportReply);
  setText("flow-preview-body",   cfg.flowBodyText);
  setText("flow-preview-cta",    cfg.flowCtaText || "Choose a Service");
  setText("flow-preview-footer", cfg.flowFooterText);
  if (cfg.welcomeBannerUrl) {
    show("current-banner-wrap", true);
    document.getElementById("current-banner-img").src = cfg.welcomeBannerUrl;
  } else { show("current-banner-wrap", false); }
}

function updateWelcomePreview(cfg) {
  const combined = (cfg.welcomeMessage || "") + (cfg.flowBodyText ? "\n\n" + cfg.flowBodyText : "");
  setText("preview-message",   combined);
  setText("preview-cta-btn",   cfg.flowCtaText || "Choose a Service");
  const bannerWrap = document.getElementById("preview-banner-wrap");
  const bannerImg  = document.getElementById("preview-banner-img");
  if (cfg.welcomeBannerUrl) { bannerImg.src = cfg.welcomeBannerUrl; bannerWrap.style.display = "block"; }
  else { bannerWrap.style.display = "none"; }
}

// ── Welcome ───────────────────────────────────────────────────────────────────
async function saveWelcome() {
  const data = await apiPost("/api/config/welcome", { welcomeMessage: val("welcomeMessage") });
  if (data.success) { toast("✅ Welcome message saved!"); updateWelcomePreview(data.config); }
  else toast("❌ Failed", true);
}

// ── Banner ────────────────────────────────────────────────────────────────────
function switchBannerTab(tab, el) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  el.classList.add("active");
  show("banner-upload", tab === "upload");
  show("banner-url",    tab === "url");
}

async function uploadBanner(input) {
  if (!input.files[0]) return;
  const form = new FormData();
  form.append("banner", input.files[0]);
  const data = await (await fetch("/api/config/banner", { method: "POST", body: form })).json();
  if (data.success) {
    toast("✅ Banner uploaded!");
    show("current-banner-wrap", true);
    document.getElementById("current-banner-img").src = data.bannerUrl;
    document.getElementById("preview-banner-img").src = data.bannerUrl;
    document.getElementById("preview-banner-wrap").style.display = "block";
  } else toast("❌ Upload failed", true);
}

async function saveBannerUrl() {
  const url = val("bannerUrlInput").trim();
  if (!url) return toast("❌ Please enter a URL", true);
  const data = await apiPost("/api/config/banner-url", { url });
  if (data.success) {
    toast("✅ Banner URL saved!");
    show("current-banner-wrap", true);
    document.getElementById("current-banner-img").src = data.bannerUrl;
    document.getElementById("preview-banner-img").src = data.bannerUrl;
    document.getElementById("preview-banner-wrap").style.display = "block";
  } else toast("❌ Failed", true);
}

async function saveCaption() {
  const data = await apiPost("/api/config/welcome", { welcomeBannerCaption: val("welcomeBannerCaption") });
  if (data.success) toast("✅ Caption saved!"); else toast("❌ Failed", true);
}

async function clearBanner() {
  const data = await (await fetch("/api/config/banner", { method: "DELETE" })).json();
  if (data.success) {
    toast("✅ Banner removed");
    show("current-banner-wrap", false);
    document.getElementById("preview-banner-wrap").style.display = "none";
  }
}

// ── Flow Settings ─────────────────────────────────────────────────────────────
async function saveFlowSettings() {
  const body = {
    flowBodyText:   val("flowBodyText"),
    flowCtaText:    val("flowCtaText"),
    flowFooterText: val("flowFooterText"),
  };
  const data = await apiPost("/api/config/welcome", body);
  if (data.success) {
    toast("✅ Flow settings saved!");
    setText("flow-preview-body",   body.flowBodyText);
    setText("flow-preview-cta",    body.flowCtaText || "Choose a Service");
    setText("flow-preview-footer", body.flowFooterText);
    setText("preview-cta-btn",     body.flowCtaText || "Choose a Service");
  } else toast("❌ Failed", true);
}

async function saveServiceReplies() {
  const body = {
    trackOrderReply: val("trackOrderReply"),
    supportReply:    val("supportReply"),
  };
  const data = await apiPost("/api/config/welcome", body);
  if (data.success) toast("✅ Replies saved!"); else toast("❌ Failed", true);
}

// ── Products ──────────────────────────────────────────────────────────────────
async function loadProducts() {
  const products = await (await fetch("/api/products")).json();
  document.getElementById("product-count").textContent = products.length;
  renderProducts(products);
}

function renderProducts(products) {
  const grid = document.getElementById("products-list");
  if (!products.length) { grid.innerHTML = '<p class="empty-state">No products yet. Add your first one above.</p>'; return; }
  grid.innerHTML = products.map((p) => `
    <div class="product-card">
      ${p.imageUrl ? `<img class="product-img" src="${p.imageUrl}" alt="${p.name}" onerror="this.style.display='none'" />`
                   : `<div class="product-img-placeholder">📦</div>`}
      <div class="product-body">
        <div class="product-name"><span class="status-dot ${p.active ? "active" : "inactive"}"></span>${p.name}</div>
        ${p.price ? `<div class="product-price">${p.price}</div>` : ""}
        ${p.description ? `<div class="product-desc">${p.description}</div>` : ""}
        <div class="product-actions">
          <button class="btn btn-ghost btn-sm" onclick='openEditModal(${JSON.stringify(p).replace(/'/g,"&#39;")})'>✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')">🗑</button>
        </div>
      </div>
    </div>`).join("");
}

async function addProduct() {
  const name = val("prod-name").trim();
  if (!name) return toast("❌ Product name is required", true);
  const body = {
    name,
    flowId:      val("prod-flowid"),
    description: val("prod-desc"),
    price:       val("prod-price"),
    tags:        val("prod-tags"),
    imageUrl:    val("prod-image"),
    productUrl:  val("prod-url"),
  };
  const data = await apiPost("/api/products", body);
  if (data.success) {
    toast("✅ Product added!");
    ["prod-name","prod-flowid","prod-desc","prod-price","prod-tags","prod-image","prod-url"].forEach((id) => setVal(id, ""));
    loadProducts();
  } else toast("❌ Failed", true);
}

async function deleteProduct(id) {
  if (!confirm("Delete this product?")) return;
  await fetch(`/api/products/${id}`, { method: "DELETE" });
  toast("✅ Product deleted");
  loadProducts();
}

// ── Edit modal ────────────────────────────────────────────────────────────────
function openEditModal(p) {
  setVal("edit-id",     p.id);
  setVal("edit-name",   p.name);
  setVal("edit-price",  p.price);
  setVal("edit-flowid", p.flowId);
  setVal("edit-desc",   p.description);
  setVal("edit-tags",   p.tags);
  setVal("edit-image",  p.imageUrl);
  setVal("edit-url",    p.productUrl);
  document.getElementById("edit-active").value = String(p.active);
  document.getElementById("edit-modal").style.display = "flex";
}

function closeModal() { document.getElementById("edit-modal").style.display = "none"; }

async function saveEditProduct() {
  const id   = val("edit-id");
  const body = {
    name:        val("edit-name"),
    price:       val("edit-price"),
    flowId:      val("edit-flowid"),
    description: val("edit-desc"),
    tags:        val("edit-tags"),
    imageUrl:    val("edit-image"),
    productUrl:  val("edit-url"),
    active:      document.getElementById("edit-active").value === "true",
  };
  const data = await (await fetch(`/api/products/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  if (data.success) { toast("✅ Product updated!"); closeModal(); loadProducts(); }
  else toast("❌ Failed", true);
}

document.getElementById("edit-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });

// ── Flow JSON ─────────────────────────────────────────────────────────────────
async function loadFlowJson() {
  const statusEl = document.getElementById("flow-status");
  const outputEl = document.getElementById("flow-json-output");
  outputEl.textContent = "Loading...";
  statusEl.textContent = "";
  try {
    const res  = await fetch("/flow.json");
    const data = await res.json();
    const json = JSON.stringify(data, null, 2);
    // Show truncated preview (base64 is huge)
    const lines = json.split("\n");
    const preview = lines.length > 200
      ? lines.slice(0, 200).join("\n") + "\n\n... (truncated for display — full JSON copied when you click Copy)"
      : json;
    outputEl.textContent = preview;
    statusEl.textContent = `✅ ${lines.length} lines · ${(json.length / 1024).toFixed(1)} KB · ${data.screens?.length || 0} screens`;
    // Store full JSON for copy
    outputEl.dataset.full = json;
  } catch (e) {
    outputEl.textContent = "Error: " + e.message;
    statusEl.textContent = "";
  }
}

function copyFlowJson() {
  const el   = document.getElementById("flow-json-output");
  const text = el.dataset.full || el.textContent;
  navigator.clipboard.writeText(text).then(() => toast("✅ Full Flow JSON copied to clipboard!"));
}

async function regenerateFlow() {
  toast("⚙️ Regenerating flow from products...");
  try {
    const res  = await fetch("/api/regenerate-flow", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      toast("✅ Flow regenerated! Now copy and republish in Meta.");
      await loadFlowJson();
    } else {
      toast("❌ Regeneration failed: " + (data.error || "unknown error"), true);
    }
  } catch (e) { toast("❌ " + e.message, true); }
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadConfig();
loadProducts();
