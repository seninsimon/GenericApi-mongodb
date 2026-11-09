import { pino } from "pino";
import { env } from "../config/env.js";

// Structured JSON logs in production; pretty, readable logs in development.
export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      'res.headers["set-cookie"]',
      "password",
      "*.password",
    ],
    censor: "[redacted]",
  },
  ...(env.isProduction || env.isTest
    ? {}
    : { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }),
});
