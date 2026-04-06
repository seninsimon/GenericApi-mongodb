import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import si from "systeminformation";
dotenv.config();

// 🔹 Core routes
import tableRoutes from "./routes/core/tableRoutes.js";
import schemaRoutes from "./routes/core/schemaRoutes.js";
import uploadRoutes from "./routes/core/uploadRoutes.js";

// 🔹 Feature routes
import authRoutes from "./routes/auth/auth.routes.js";
import orderRoutes from "./routes/order.routes.js";
import addressRoutes from "./routes/address.routes.js";
import paymentRoutes from "./routes/payment.routes.js";



const app = express();

// ✅ Middlewares
app.use(cors());
app.use(express.json());

// ✅ Static files
app.use("/uploads", express.static("uploads"));

// ✅ DB connection
connectDB();

// ================= ROUTES =================

// 🔹 Core system
app.use("/api", tableRoutes);
app.use("/api", schemaRoutes);
app.use("/api", uploadRoutes);

// 🔹 Auth
app.use("/api/auth", authRoutes);

// 🔹 Address (NEW)
app.use("/api/address", addressRoutes);

// 🔹 Orders
app.use("/api/orders", orderRoutes);

// 🔹 Payments
app.use("/api/payment", paymentRoutes);

// ================= HEALTH =================

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

app.get("/api/system-health", async (req, res) => {
  try {
    const cpu = await si.currentLoad();
    const mem = await si.mem();
    const disk = await si.fsSize();

    res.json({
      cpu: cpu.currentLoad.toFixed(1),
      ram: ((mem.used / mem.total) * 100).toFixed(1),
      ramTotal: (mem.total / 1024 / 1024 / 1024).toFixed(2),
      ramUsed: (mem.used / 1024 / 1024 / 1024).toFixed(2),
      disk: disk[0].use.toFixed(1),
      diskTotal: (disk[0].size / 1024 / 1024 / 1024).toFixed(2),
      diskUsed: (disk[0].used / 1024 / 1024 / 1024).toFixed(2),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch system health" });
  }
});

// ================= SERVER =================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});