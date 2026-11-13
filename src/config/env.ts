import "dotenv/config";

// All configuration comes from environment variables (see .env.example).

const str = (name: string, fallback = ""): string => process.env[name] ?? fallback;
const int = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
};
const bool = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value === "true";
};

const nodeEnv = str("NODE_ENV", "development");

export const env = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  isTest: nodeEnv === "test",
  port: int("PORT", 5000),

  databaseUrl: str("DATABASE_URL"),
  pgPoolMax: int("PG_POOL_MAX", 10),
  slowQueryMs: int("SLOW_QUERY_MS", 500),
  // above this many rows, list totals are estimated instead of counted
  exactCountLimit: int("EXACT_COUNT_LIMIT", 50_000),

  storageDriver: str("STORAGE_DRIVER", "s3") as "s3" | "memory",
  s3: {
    endpoint: str("S3_ENDPOINT"),
    region: str("S3_REGION", "us-east-1"),
    accessKey: str("S3_ACCESS_KEY"),
    secretKey: str("S3_SECRET_KEY"),
    bucket: str("S3_BUCKET", "erp-uploads"),
    forcePathStyle: bool("S3_FORCE_PATH_STYLE", true),
  },
  uploadMaxBytes: int("UPLOAD_MAX_MB", 50) * 1024 * 1024,
  importMaxBytes: int("IMPORT_MAX_MB", 20) * 1024 * 1024,
  jobFileRetentionDays: int("JOB_FILE_RETENTION_DAYS", 14),

  adminUsername: str("ADMIN_USERNAME", "admin"),
  adminPassword: str("ADMIN_PASSWORD"),
  corsOrigins: str("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  cookieSecure: bool("COOKIE_SECURE", false),

  logLevel: str("LOG_LEVEL", nodeEnv === "test" ? "silent" : "info"),
  // GET /metrics requires "Authorization: Bearer <token>"; disabled when empty
  metricsToken: str("METRICS_TOKEN"),
  // run the background job worker inside the API process (handy in development;
  // in docker a separate "worker" service runs it)
  runWorker: bool("RUN_WORKER", true),

  // Email is set up in the app (Administration → Email). MAIL_TRANSPORT=memory
  // keeps emails in memory instead of sending them (tests).
  mailTransport: str("MAIL_TRANSPORT", "smtp") as "smtp" | "memory",
};

export type Env = typeof env;
