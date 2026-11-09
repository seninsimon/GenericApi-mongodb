import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import { initStorage } from "./config/storage.js";
import si from "systeminformation";
import { ensureInitialAdmin } from "./auth/bootstrap.js";
import { requireAdmin, requireAuth } from "./middleware/auth.js";
import authRoutes from "./routes/authRoutes.js";
import tableRoutes from "./routes/tableRoutes.js";
import schemaRoutes from "./routes/schemaRoutes.js";
import uploadRoutes, { fileRouter } from "./routes/uploadRoutes.js";

dotenv.config();

const app = express();

// behind nginx (docker) the client IP comes from X-Forwarded-For
app.set("trust proxy", "loopback, linklocal, uniquelocal");

// Browsers only send the session cookie cross-origin to allowed origins
// (e.g. the Vite dev server). In docker, nginx serves app + API on one origin.
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// serve uploaded files from object storage
app.use("/uploads", fileRouter);

// routes
app.use("/api", authRoutes);
app.use("/api", tableRoutes);
app.use("/api", schemaRoutes);
app.use("/api", uploadRoutes);

app.get("/", async (req, res) => {
  res.send("Server is running");
});

// public liveness check (used by the frontend while the server starts)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/system-health", requireAuth, requireAdmin, async (req, res) => {
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

// malformed JSON bodies etc.
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON body" });
  }
  console.error(err);
  res.status(500).json({ message: "Something went wrong" });
});

const PORT = process.env.PORT || 5000;

await connectDB();
await initStorage();
await ensureInitialAdmin();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
