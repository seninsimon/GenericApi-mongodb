import crypto from "crypto";
import { razorpay } from "../config/razorpay.js";
import Order from "../models/order.model.js";

// ✅ CREATE ORDER
export const createOrder = async (req, res) => {
  try {
    const { items, totalAmount, address } = req.body;

    // 🔥 Create Razorpay order
    const razorpayOrder = await razorpay.orders.create({
      amount: totalAmount * 100, // convert to paise
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    // ✅ Save order in DB (IMPORTANT: store razorpayOrderId)
    const order = await Order.create({
      user: req.user._id,
      items,
      totalAmount,
      address,
      paymentMethod: "ONLINE",
      paymentStatus: "pending",
      razorpayOrderId: razorpayOrder.id, // ✅ ADDED
    });

    res.json({
      orderId: order._id,
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
    });
  } catch (error) {
    console.log("CREATE ORDER ERROR:", error);
    res.status(500).json({ message: "Order creation failed" });
  }
};

// ✅ VERIFY PAYMENT
export const verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId,
    } = req.body;

    // 🔐 Generate expected signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    // ❌ If signature mismatch
    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        message: "Payment verification failed",
      });
    }

    // ✅ Update order after successful payment
    await Order.findByIdAndUpdate(orderId, {
      paymentStatus: "paid",
      orderStatus: "confirmed",
      razorpayPaymentId: razorpay_payment_id, // ✅ SAVE PAYMENT ID
    });

    res.json({
      message: "Payment successful",
    });
  } catch (error) {
    console.log("VERIFY PAYMENT ERROR:", error);
    res.status(500).json({ message: "Verification failed" });
  }
};