import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";

import tableRoutes from "./routes/tableRoutes.js";
import schemaRoutes from "./routes/schemaRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";

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

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});