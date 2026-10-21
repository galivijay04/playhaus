const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    id: { type: String, default: "" },
    name: { type: String, required: true },
    imageUrl: { type: String, default: "" },
    price: { type: Number, required: true, default: 1 },
    qty: { type: Number, required: true, default: 1 },
    lineTotal: { type: Number, default: 1 },
  },
  { _id: false }
);

const locationSchema = new mongoose.Schema(
  {
    latitude: { type: Number },
    longitude: { type: Number },
    name: { type: String },
    address: { type: String },
    url: { type: String },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    sender: { type: String, required: true, index: true },
    customerName: { type: String, default: "Customer" },
    items: [orderItemSchema],
    itemsTotal: { type: Number, required: true, default: 1 },
    deliveryFee: { type: Number, default: 0 },
    totalPayable: { type: Number, required: true, default: 1 },
    expectedDelivery: { type: String, default: "" },
    buyerNote: { type: String, default: "" },
    paymentMethod: { type: String, default: null },
    isPaid: { type: Boolean, default: false, index: true },
    paidAt: { type: Date, default: null },
    location: { type: locationSchema, default: null },
    step: {
      type: String,
      enum: [
        "AWAITING_PAYMENT",
        "AWAITING_PAYMENT_VERIFICATION",
        "AWAITING_LOCATION",
        "ORDER_CONFIRMED",
        "CANCELLED",
      ],
      default: "AWAITING_PAYMENT",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
