import multer from "multer";

// Files are buffered in memory and then streamed to object storage.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB, matches nginx client_max_body_size
});
