import express from "express";
import { randomUUID } from "crypto";
import { pipeline } from "stream";
import { upload } from "../middleware/uploadMiddleware.js";
import { requireAuth } from "../middleware/auth.js";
import { getObject, putObject, UPLOAD_URL_PREFIX } from "../config/storage.js";

// keep letters/digits/._- so the key is safe inside a URL path
const safeFileName = (name) =>
  (name || "file").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-150);

// multer decodes multipart file names as latin1; recover the UTF-8 name
const decodeFileName = (name = "") =>
  /[^\u0000-ÿ]/.test(name) ? name : Buffer.from(name, "latin1").toString("utf8");

const makeKey = (originalName) =>
  `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileName(originalName)}`;

const router = express.Router();

router.post("/upload", requireAuth, upload.array("files"), async (req, res) => {
  try {
    const files = await Promise.all(
      (req.files ?? []).map(async (file) => {
        const name = decodeFileName(file.originalname);
        const key = makeKey(name);
        await putObject(key, file.buffer, file.mimetype);
        return { url: `${UPLOAD_URL_PREFIX}${key}`, name };
      })
    );

    res.json(files);
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ message: "Upload failed" });
  }
});

export const fileRouter = express.Router();

// files are only served to logged-in users (the session cookie is sent with <img> requests)
fileRouter.get("/*key", requireAuth, async (req, res) => {
  const key = [].concat(req.params.key).join("/");

  try {
    const object = await getObject(key, req.headers.range);

    res.status(object.ContentRange ? 206 : 200);
    res.set({
      "Content-Type": object.ContentType || "application/octet-stream",
      "Accept-Ranges": "bytes",
      // keys are unique per upload, so files never change
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // never run scripts from uploaded HTML/SVG files
      "Content-Security-Policy": "sandbox",
    });
    if (object.ContentLength != null) res.set("Content-Length", String(object.ContentLength));
    if (object.ContentRange) res.set("Content-Range", object.ContentRange);
    if (object.ETag) res.set("ETag", object.ETag);
    if (object.LastModified) res.set("Last-Modified", object.LastModified.toUTCString());

    pipeline(object.Body, res, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === "NoSuchKey") {
      return res.status(404).json({ message: "File not found" });
    }
    if (status === 416) {
      return res.status(416).end();
    }
    console.error("File fetch error:", error);
    res.status(500).json({ message: "Failed to fetch file" });
  }
});

export default router;
