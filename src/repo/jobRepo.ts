import { query } from "../db/pool.js";

// Background jobs (CSV import/export). The worker claims queued jobs with
// FOR UPDATE SKIP LOCKED, so several workers can run safely.

export type JobType = "export" | "import";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobResult {
  rows?: number;
  inserted?: number;
  updated?: number;
  failed?: number;
  errors?: { row: number; message: string }[];
}

export interface Job {
  _id: string;
  type: JobType;
  status: JobStatus;
  tableName: string;
  userId: string;
  username: string;
  params: Record<string, unknown>;
  progress: number;
  result: JobResult | null;
  error: string | null;
  fileKey: string | null;
  fileName: string | null;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

type JobRow = {
  _id: string;
  type: JobType;
  status: JobStatus;
  table_name: string;
  user_id: string;
  username: string;
  params: Record<string, unknown>;
  progress: number;
  result: JobResult | null;
  error: string | null;
  file_key: string | null;
  file_name: string | null;
  attempts: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

const toJob = (r: JobRow): Job => ({
  _id: r._id,
  type: r.type,
  status: r.status,
  tableName: r.table_name,
  userId: r.user_id,
  username: r.username,
  params: r.params,
  progress: r.progress,
  result: r.result,
  error: r.error,
  fileKey: r.file_key,
  fileName: r.file_name,
  attempts: r.attempts,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

// API shape (no internal storage key)
export const publicJob = (job: Job) => {
  const { fileKey, params, attempts, ...rest } = job;
  return { ...rest, hasFile: Boolean(fileKey) };
};

export const JOBS_CHANNEL = "erp_jobs";

export async function createJob(input: {
  id?: string;
  type: JobType;
  tableName: string;
  userId: string;
  username: string;
  params?: Record<string, unknown>;
}) {
  const { rows } = await query<JobRow>(
    `INSERT INTO jobs (_id, type, table_name, user_id, username, params)
     VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, $5, $6::jsonb) RETURNING *`,
    [input.id ?? null, input.type, input.tableName, input.userId, input.username, JSON.stringify(input.params ?? {})]
  );
  await query(`SELECT pg_notify($1, $2)`, [JOBS_CHANNEL, rows[0]._id]);
  return toJob(rows[0]);
}

export async function claimNextJob(): Promise<Job | null> {
  const { rows } = await query<JobRow>(
    `UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1
     WHERE _id = (
       SELECT _id FROM jobs WHERE status = 'queued'
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING *`
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export const setProgress = (id: string, progress: number) =>
  query(`UPDATE jobs SET progress = $2 WHERE _id = $1`, [id, progress]);

export const finishJob = (
  id: string,
  outcome: { status: "done" | "failed"; result?: JobResult | null; error?: string | null; fileKey?: string | null; fileName?: string | null; progress?: number }
) =>
  query(
    `UPDATE jobs SET status = $2, result = $3::jsonb, error = $4, file_key = $5, file_name = $6,
       progress = COALESCE($7, progress), finished_at = now()
     WHERE _id = $1`,
    [
      id,
      outcome.status,
      outcome.result ? JSON.stringify(outcome.result) : null,
      outcome.error ?? null,
      outcome.fileKey ?? null,
      outcome.fileName ?? null,
      outcome.progress ?? null,
    ]
  );

export async function getJob(id: string) {
  const { rows } = await query<JobRow>(`SELECT * FROM jobs WHERE _id = $1`, [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function listJobs(opts: { userId: string | null; page: number; limit: number }) {
  const params: unknown[] = [];
  let where = "";
  if (opts.userId) {
    params.push(opts.userId);
    where = `WHERE user_id = $1`;
  }
  const [{ rows }, { rows: count }] = await Promise.all([
    query<JobRow>(
      `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.limit, (opts.page - 1) * opts.limit]
    ),
    query<{ total: number }>(`SELECT count(*)::int AS total FROM jobs ${where}`, params),
  ]);
  return { data: rows.map((r) => publicJob(toJob(r))), total: count[0].total, page: opts.page, limit: opts.limit };
}

// Jobs left "running" by a worker that died: retry once, then give up.
export const recoverStaleJobs = () =>
  query(
    `UPDATE jobs SET
       status = CASE WHEN attempts < 2 THEN 'queued' ELSE 'failed' END,
       error = CASE WHEN attempts < 2 THEN NULL ELSE 'The worker stopped while running this job' END,
       finished_at = CASE WHEN attempts < 2 THEN NULL ELSE now() END
     WHERE status = 'running' AND started_at < now() - interval '30 minutes'`
  );

// Old job files to delete (retention).
export async function expiredJobFiles(days: number) {
  const { rows } = await query<{ _id: string; file_key: string; import_key: string | null }>(
    `SELECT _id, file_key, params->>'uploadKey' AS import_key FROM jobs
     WHERE finished_at < now() - make_interval(days => $1) AND (file_key IS NOT NULL OR params ? 'uploadKey')`,
    [days]
  );
  return rows;
}

export const clearJobFile = (id: string) =>
  query(`UPDATE jobs SET file_key = NULL, params = params - 'uploadKey' WHERE _id = $1`, [id]);
