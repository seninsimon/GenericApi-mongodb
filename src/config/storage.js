import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// S3-compatible object storage (RustFS locally / in Docker; also works with
// AWS S3, Cloudflare R2, Garage, SeaweedFS, ...).

// Uploaded files are referenced as "/uploads/<key>" and served by GET /uploads/<key>.
export const UPLOAD_URL_PREFIX = "/uploads/";

let s3;
let bucket;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureBucket = async () => {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404) throw error;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Created bucket "${bucket}"`);
  }
};

export const initStorage = async () => {
  const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET } = process.env;

  if (!S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY || !S3_BUCKET) {
    console.error("S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY and S3_BUCKET must be set");
    process.exit(1);
  }

  bucket = S3_BUCKET;
  s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION || "us-east-1",
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    // self-hosted S3 servers address buckets by path, not subdomain
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    // only send/validate checksums when required; not every S3-compatible server supports them
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  // the storage server may still be starting (e.g. under docker compose)
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureBucket();
      console.log("Object storage connected");
      return;
    } catch (error) {
      if (attempt >= 15) {
        console.error("Could not connect to object storage:", error);
        process.exit(1);
      }
      await sleep(2000);
    }
  }
};

export const putObject = (key, body, contentType) =>
  s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );

export const getObject = (key, range) =>
  s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));

export const deleteObject = (key) =>
  s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
