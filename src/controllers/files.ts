import busboy from "busboy";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { env } from "../config/env.js";
import { HttpError, param } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import {
  ObjectNotFoundError,
  RangeNotSatisfiableError,
  storage,
  UPLOAD_URL_PREFIX,
} from "../storage.js";

// keep letters/digits/._- so the key is safe inside a URL path
const safeFileName = (name: string) => (name || "file").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-150);

const makeKey = (name: string) => `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileName(name)}`;

const MAX_FILES = 20;

// POST /api/upload (multipart, field "files"): streams each file straight into
// object storage; nothing is buffered in memory.
export function uploadHandler(req: Request, res: Response) {
  if (!req.is("multipart/form-data")) throw new HttpError(400, "Expected multipart/form-data");

  const bb = busboy({
    headers: req.headers,
    defParamCharset: "utf8", // UTF-8 file names
    limits: { fileSize: env.uploadMaxBytes, files: MAX_FILES },
  });
  const uploads: Promise<{ url: string; name: string; key: string }>[] = [];
  let failed: HttpError | null = null;

  bb.on("file", (field, stream, info) => {
    if (field !== "files") {
      stream.resume();
      return;
    }
    const name = info.filename || "file";
    const key = makeKey(name);
    let tooLarge = false;
    stream.on("limit", () => {
      tooLarge = true;
    });
    const upload = storage.put(key, stream, info.mimeType).then(async () => {
      if (tooLarge) {
        await storage.delete(key).catch(() => {});
        throw new HttpError(413, `"${name}" is larger than ${Math.round(env.uploadMaxBytes / 1024 / 1024)} MB`);
      }
      return { url: `${UPLOAD_URL_PREFIX}${key}`, name, key };
    });
    // may fail before "close"; it's handled there via allSettled
    upload.catch(() => {});
    uploads.push(upload);
  });
  bb.on("filesLimit", () => {
    failed = new HttpError(400, `At most ${MAX_FILES} files per upload`);
  });

  return new Promise<void>((resolve, reject) => {
    bb.on("error", (err) => reject(new HttpError(400, `Upload failed: ${(err as Error).message}`)));
    bb.on("close", async () => {
      const settled = await Promise.allSettled(uploads);
      const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      const error = failed ?? settled.find((s): s is PromiseRejectedResult => s.status === "rejected")?.reason;
      if (error) {
        // all or nothing: don't leave half of a multi-file upload behind
        await Promise.all(ok.map((f) => storage.delete(f.key).catch(() => {})));
        reject(error instanceof HttpError ? error : new HttpError(500, "Upload failed"));
        return;
      }
      res.json(ok.map(({ url, name }) => ({ url, name })));
      resolve();
    });
    req.pipe(bb);
  });
}

// GET /uploads/<key>: streams a stored file to logged-in users.
export async function serveFileHandler(req: Request, res: Response) {
  const key = param(req, "key");
  // job files (exports/, imports/) are only served through /api/jobs/:id/download
  if (!key || key.includes("..") || /^(exports|imports)\//.test(key)) throw new HttpError(404, "File not found");

  try {
    const object = await storage.get(key, req.headers.range);
    res.status(object.contentRange ? 206 : 200);
    res.set({
      "Content-Type": object.contentType,
      "Accept-Ranges": "bytes",
      // keys are unique per upload, so files never change
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // never run scripts from uploaded HTML/SVG files
      "Content-Security-Policy": "sandbox",
    });
    if (object.contentLength != null) res.set("Content-Length", String(object.contentLength));
    if (object.contentRange) res.set("Content-Range", object.contentRange);
    if (object.etag) res.set("ETag", object.etag);
    if (object.lastModified) res.set("Last-Modified", object.lastModified.toUTCString());
    await pipeline(object.body, res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw new HttpError(404, "File not found");
    if (error instanceof RangeNotSatisfiableError) throw new HttpError(416, "Range not satisfiable");
    if (res.headersSent) {
      logger.warn({ err: error, key }, "file stream interrupted");
      return;
    }
    throw error;
  }
}
