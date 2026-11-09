import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

// Object storage for uploaded files and job files. "s3" works with RustFS,
// MinIO, AWS S3, Cloudflare R2, ...; "memory" is for tests.

export interface StoredObject {
  body: Readable;
  contentType: string;
  contentLength?: number;
  contentRange?: string;
  etag?: string;
  lastModified?: Date;
}

export class ObjectNotFoundError extends Error {}
export class RangeNotSatisfiableError extends Error {}

export interface Storage {
  init(): Promise<void>;
  // streams `body` into the bucket; memory use stays bounded for any size
  put(key: string, body: Readable | Buffer, contentType: string): Promise<void>;
  get(key: string, range?: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

/* ---------------- S3 ---------------- */

class S3Storage implements Storage {
  private client = new S3Client({
    endpoint: env.s3.endpoint || undefined,
    region: env.s3.region,
    credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
    // self-hosted S3 servers address buckets by path, not subdomain
    forcePathStyle: env.s3.forcePathStyle,
    // not every S3-compatible server supports the newer default checksums
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  private bucket = env.s3.bucket;

  async init() {
    if (!env.s3.endpoint && !env.s3.accessKey) {
      throw new Error("S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY must be set");
    }
    // the storage server may still be starting (e.g. under docker compose)
    for (let attempt = 1; ; attempt++) {
      try {
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch (error) {
          if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          logger.info({ bucket: this.bucket }, "created bucket");
        }
        return;
      } catch (error) {
        if (attempt >= 15) throw error;
        logger.warn({ attempt }, "object storage not reachable yet, retrying");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async put(key: string, body: Readable | Buffer, contentType: string) {
    // multipart upload in 8 MB parts, 2 at a time: at most ~16 MB in memory
    await new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType || "application/octet-stream" },
      partSize: 8 * 1024 * 1024,
      queueSize: 2,
    }).done();
  }

  async get(key: string, range?: string): Promise<StoredObject> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
      return {
        body: object.Body as Readable,
        contentType: object.ContentType || "application/octet-stream",
        contentLength: object.ContentLength,
        contentRange: object.ContentRange,
        etag: object.ETag,
        lastModified: object.LastModified,
      };
    } catch (error) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.$metadata?.httpStatusCode === 404 || err.name === "NoSuchKey") throw new ObjectNotFoundError(key);
      if (err.$metadata?.httpStatusCode === 416) throw new RangeNotSatisfiableError(key);
      throw error;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/* ---------------- memory (tests) ---------------- */

class MemoryStorage implements Storage {
  objects = new Map<string, { data: Buffer; contentType: string }>();

  async init() {}

  async put(key: string, body: Readable | Buffer, contentType: string) {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(body)) chunks.push(body);
    else for await (const chunk of body) chunks.push(Buffer.from(chunk));
    this.objects.set(key, { data: Buffer.concat(chunks), contentType });
  }

  async get(key: string, range?: string): Promise<StoredObject> {
    const object = this.objects.get(key);
    if (!object) throw new ObjectNotFoundError(key);
    let data = object.data;
    let contentRange: string | undefined;
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      if (start >= data.length) throw new RangeNotSatisfiableError(key);
      contentRange = `bytes ${start}-${end}/${data.length}`;
      data = data.subarray(start, end + 1);
    }
    return { body: Readable.from(data), contentType: object.contentType, contentLength: data.length, contentRange };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

export const storage: Storage = env.storageDriver === "memory" ? new MemoryStorage() : new S3Storage();

// Uploaded files are referenced as "/uploads/<key>" and served by GET /uploads/<key>.
export const UPLOAD_URL_PREFIX = "/uploads/";

export const uploadKeyFromUrl = (url: string): string | null => {
  const clean = url.startsWith("/") ? url : `/${url}`;
  if (!clean.startsWith(UPLOAD_URL_PREFIX)) return null;
  const key = clean.slice(UPLOAD_URL_PREFIX.length);
  // job files live under exports/ and imports/ and are never served as uploads
  return key && !key.includes("..") ? key : null;
};

export async function deleteUploads(urls: string[]): Promise<void> {
  for (const url of urls) {
    const key = uploadKeyFromUrl(url);
    if (!key) continue;
    try {
      await storage.delete(key);
    } catch (err) {
      logger.error({ err, key }, "file deletion failed");
    }
  }
}
