import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import si from "systeminformation";
import tableRoutes from "./routes/core/tableRoutes.js";
import schemaRoutes from "./routes/core/schemaRoutes.js";
import uploadRoutes from "./routes/core/uploadRoutes.js";
import authRoutes from "./routes/auth/auth.routes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// serve uploaded files
app.use("/uploads", express.static("uploads"));

connectDB();

// routes
app.use("/api", tableRoutes);
app.use("/api", schemaRoutes);
app.use("/api", uploadRoutes);

app.use("/api/auth", authRoutes);



app.get("/", async (req, res) => {
  res.send("Server is running");
});

app.get("/api/system-health", async (req, res) => {
  try {
    const cpu = await si.currentLoad();
    const mem = await si.mem();
    const disk = await si.fsSize();

    res.json({
      cpu: cpu.currentLoad.toFixed(1), // %
      ram: ((mem.used / mem.total) * 100).toFixed(1), // %
      ramTotal: (mem.total / 1024 / 1024 / 1024).toFixed(2), // GB
      ramUsed: (mem.used / 1024 / 1024 / 1024).toFixed(2),
      disk: disk[0].use.toFixed(1), // %
      diskTotal: (disk[0].size / 1024 / 1024 / 1024).toFixed(2),
      diskUsed: (disk[0].used / 1024 / 1024 / 1024).toFixed(2),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch system health" });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});