const mongoose = require("mongoose");

const userSessionSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    activeOrderId: { type: String, default: null },
    cart: { type: Array, default: [] },
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("UserSession", userSessionSchema);
