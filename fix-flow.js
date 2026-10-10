const fs = require("fs");

const f  = JSON.parse(fs.readFileSync("flow.json", "utf8"));
const cp = f.screens.find((s) => s.id === "CHOOSE_PRODUCT");
const rb = cp.layout.children.find((c) => c.type === "RadioButtonsGroup");

// Add on-select-action per radio item so tapping a product
// immediately navigates to that product's detail screen
rb["data-source"] = rb["data-source"].map((item) => ({
  ...item,
  "on-select-action": {
    name: "navigate",
    next: { type: "screen", name: "DETAIL_" + item.id.toUpperCase() },
    payload: {
      service: "${data.service}",
      product: item.id,
    },
  },
}));

// Keep the footer as a fallback "View Details" for the selected item
const footer = cp.layout.children.find((c) => c.type === "Footer");
footer.label = "View Details";
footer["on-click-action"] = {
  name: "navigate",
  next: { type: "screen", name: "DETAIL_SNAP_MAGNET" },
  payload: {
    service: "${data.service}",
    product: "${form.product}",
  },
};

fs.writeFileSync("flow.json", JSON.stringify(f, null, 2), "utf8");
fs.writeFileSync("PASTE-THIS-IN-META.json", JSON.stringify(f, null, 2), "utf8");

console.log("✅ Per-product navigation added");
console.log("Sample radio item:", JSON.stringify(rb["data-source"][0], null, 2));
console.log("Screens:", f.screens.map((s) => s.id).join(" → "));
