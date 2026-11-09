import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import si from "systeminformation";
import { env } from "./config/env.js";
import { serveFileHandler } from "./controllers/files.js";
import { query } from "./db/pool.js";
import { handle, HttpError } from "./lib/http.js";
import { logger } from "./lib/logger.js";
import { httpDuration, registry } from "./lib/metrics.js";
import { requireAdmin, requireAjaxHeader, requireAuth } from "./middleware/auth.js";
import { apiRouter } from "./routes.js";

export function createApp() {
  const app = express();

  // behind nginx (docker) the client IP comes from X-Forwarded-For
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  app.disable("x-powered-by");

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers["x-request-id"] as string) || randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      autoLogging: { ignore: (req) => req.url === "/api/health" || req.url === "/metrics" },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    })
  );

  // request duration metrics, labelled by route pattern (not raw URL)
  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.on("finish", () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  });

  app.use(
    helmet({
      // the SPA dev server (another port) loads images from /uploads
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  );
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "5mb" }));
  app.use(cookieParser());

  app.get("/", (_req, res) => {
    res.send("Server is running");
  });

  // liveness + database check (used by docker healthchecks and the SPA)
  app.get(
    "/api/health",
    handle(async (_req, res) => {
      try {
        await query("SELECT 1");
        res.json({ status: "ok" });
      } catch {
        res.status(503).json({ status: "unavailable" });
      }
    })
  );

  // Prometheus metrics; enabled only when METRICS_TOKEN is set
  app.get(
    "/metrics",
    handle(async (req, res) => {
      if (!env.metricsToken || req.get("authorization") !== `Bearer ${env.metricsToken}`) {
        throw new HttpError(404, "Not found");
      }
      res.set("Content-Type", registry.contentType).send(await registry.metrics());
    })
  );

  app.get(
    "/api/system-health",
    requireAuth,
    requireAdmin,
    handle(async (_req, res) => {
      const [cpu, mem, disk] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()]);
      const gb = (bytes: number) => (bytes / 1024 / 1024 / 1024).toFixed(2);
      res.json({
        cpu: cpu.currentLoad.toFixed(1),
        ram: ((mem.used / mem.total) * 100).toFixed(1),
        ramTotal: gb(mem.total),
        ramUsed: gb(mem.used),
        disk: disk[0]?.use.toFixed(1) ?? "0",
        diskTotal: gb(disk[0]?.size ?? 0),
        diskUsed: gb(disk[0]?.used ?? 0),
      });
    })
  );

  app.use("/api", requireAjaxHeader, apiRouter);
  app.get("/uploads/*key", requireAuth, handle(serveFileHandler));

  app.use((_req, _res, next) => next(new HttpError(404, "Not found")));

  // errors -> JSON
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ message: err.message, ...(err.errors ? { errors: err.errors } : {}) });
      return;
    }
    if ((err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ message: "Invalid JSON body" });
      return;
    }
    if ((err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ message: "Request body too large" });
      return;
    }
    req.log?.error({ err }, "unhandled error");
    if (!res.headersSent) res.status(500).json({ message: "Something went wrong" });
  });

  return app;
}
