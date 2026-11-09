import pg from "pg";
import { pruneLoginAttempts } from "../auth/throttle.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { jobsProcessed } from "../lib/metrics.js";
import {
  claimNextJob,
  clearJobFile,
  expiredJobFiles,
  finishJob,
  JOBS_CHANNEL,
  recoverStaleJobs,
  type Job,
} from "../repo/jobRepo.js";
import { pruneSessions } from "../repo/userRepo.js";
import { storage } from "../storage.js";
import { runExport } from "./exportJob.js";
import { runImport } from "./importJob.js";

const HANDLERS = { export: runExport, import: runImport } as const;
const POLL_MS = 5_000;
const HOUSEKEEPING_MS = 10 * 60_000;

// Run one job to completion and record the outcome.
export async function runJob(job: Job): Promise<void> {
  const log = logger.child({ jobId: job._id, type: job.type, table: job.tableName });
  log.info("job started");
  try {
    const outcome = await HANDLERS[job.type](job);
    await finishJob(job._id, { status: "done", ...outcome });
    jobsProcessed.inc({ type: job.type, status: "done" });
    log.info({ result: outcome.result }, "job finished");
  } catch (err) {
    await finishJob(job._id, { status: "failed", error: (err as Error).message || "Job failed" });
    jobsProcessed.inc({ type: job.type, status: "failed" });
    log.error({ err }, "job failed");
  }
}

// Process queued jobs until the queue is empty (used by tests).
export async function drainJobs(): Promise<number> {
  let count = 0;
  for (let job = await claimNextJob(); job; job = await claimNextJob()) {
    await runJob(job);
    count++;
  }
  return count;
}

async function housekeeping() {
  try {
    await recoverStaleJobs();
    await pruneSessions();
    await pruneLoginAttempts();
    for (const job of await expiredJobFiles(env.jobFileRetentionDays)) {
      for (const key of [job.file_key, job.import_key]) {
        if (key) await storage.delete(key).catch(() => {});
      }
      await clearJobFile(job._id);
    }
  } catch (err) {
    logger.error({ err }, "housekeeping failed");
  }
}

// Long-running worker loop. Woken immediately by NOTIFY when a job is queued,
// with polling as a fallback. Returns a stop function (finishes the current job).
export async function startWorker(): Promise<() => Promise<void>> {
  let running = true;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  let listener: pg.Client | null = null;
  const listen = async () => {
    try {
      listener = new pg.Client({ connectionString: env.databaseUrl });
      listener.on("notification", () => wake?.());
      listener.on("error", (err) => {
        logger.warn({ err }, "job listener lost connection, reconnecting");
        listener?.end().catch(() => {});
        if (running) setTimeout(listen, 2000);
      });
      await listener.connect();
      await listener.query(`LISTEN ${JOBS_CHANNEL}`);
    } catch (err) {
      logger.warn({ err }, "job listener failed to connect, polling only");
      if (running) setTimeout(listen, 5000);
    }
  };
  await listen();

  await housekeeping();
  const housekeepingTimer = setInterval(housekeeping, HOUSEKEEPING_MS);

  const loop = (async () => {
    while (running) {
      let job: Job | null = null;
      try {
        job = await claimNextJob();
      } catch (err) {
        logger.error({ err }, "could not claim a job");
      }
      if (job) await runJob(job);
      else await sleep(POLL_MS);
    }
  })();

  logger.info("job worker started");
  return async () => {
    running = false;
    clearInterval(housekeepingTimer);
    (wake as (() => void) | null)?.();
    await loop;
    await (listener as pg.Client | null)?.end().catch(() => {});
  };
}
