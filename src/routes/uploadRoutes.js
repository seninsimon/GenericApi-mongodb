import express from "express";
import { upload } from "../middleware/uploadMiddleware.js";

const router = express.Router();

router.post("/upload", upload.array("files"), (req, res) => {
  try {
    const files = req.files.map((file) => ({
      url: `/uploads/${file.filename}`,
      name: file.originalname,
    }));

    res.json(files);
  } catch (error) {
    res.status(500).json({ message: "Upload failed" });
  }
});

export default router;