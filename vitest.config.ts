import { defineConfig } from "vitest/config";

// Tests run against a real PostgreSQL database (TEST_DATABASE_URL, whose name
// must end in "_test" — it is wiped) and in-memory file storage.
export default defineConfig({
  test: {
    globalSetup: ["./tests/globalSetup.ts"],
    // test files share one database
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      STORAGE_DRIVER: "memory",
      RUN_WORKER: "false",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "admin-test-pass",
      UPLOAD_MAX_MB: "1",
      LOG_LEVEL: "silent",
      // emails go to an in-memory mailbox (src/mail/mailer.ts), never out
      MAIL_TRANSPORT: "memory",
    },
  },
});
