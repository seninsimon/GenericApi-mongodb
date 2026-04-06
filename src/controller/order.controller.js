import Order from "../models/order.model.js";

// 🛒 CREATE ORDER
export const createOrder = async (req, res) => {
  try {
    const { items, totalAmount, address, paymentMethod } = req.body;

    const order = await Order.create({
      user: req.user._id,
      items,
      totalAmount,
      address,
      paymentMethod,
      paymentStatus: paymentMethod === "COD" ? "pending" : "paid",
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// 📦 GET MY ORDERS
export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id }).sort({
      createdAt: -1,
    });

    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};