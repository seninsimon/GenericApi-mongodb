import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
  productId: String,
  title: String,
  price: Number,
  quantity: Number,
  image: String,
});

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    items: [orderItemSchema],

    totalAmount: Number,

    address: {
      name: String,
      phone: String,
      pincode: String,
      city: String,
      state: String,
      house: String,
      area: String,
    },

    paymentMethod: {
      type: String,
      enum: ["COD", "ONLINE"],
      default: "COD",
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
    },

    orderStatus: {
      type: String,
      enum: [
        "placed",
        "confirmed",
        "shipped",
        "out_for_delivery",
        "delivered",
        "cancelled",
      ],
      default: "placed",
    },
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);