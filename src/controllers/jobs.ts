import busboy from "busboy";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { allowedDepartments, isAdmin } from "../auth/access.js";
import { env } from "../config/env.js";
import { HttpError, intParam, param } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { createJob, getJob, listJobs, publicJob } from "../repo/jobRepo.js";
import { ObjectNotFoundError, storage } from "../storage.js";
import { loadTable } from "./records.js";

// POST /api/table/:collection/export
export async function startExportHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "view");
  const job = await createJob({ type: "export", tableName: schema.tableName, userId: user._id, username: user.username });
  res.status(202).json({ job: publicJob(job) });
}

// POST /api/table/:collection/import (multipart: "file" CSV, optional "departmentId")
export async function startImportHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "create");
  if (!req.is("multipart/form-data")) throw new HttpError(400, "Expected multipart/form-data");

  const jobId = randomUUID();
  const uploadKey = `imports/${jobId}.csv`;
  const fields: Record<string, string> = {};
  let upload: Promise<void> | null = null;
  let tooLarge = false;
  let originalName = "";

  const bb = busboy({ headers: req.headers, defParamCharset: "utf8", limits: { fileSize: env.importMaxBytes, files: 1 } });
  bb.on("field", (name, value) => {
    fields[name] = value;
  });
  bb.on("file", (name, stream, info) => {
    if (name !== "file" || upload) {
      stream.resume();
      return;
    }
    originalName = info.filename ?? "";
    stream.on("limit", () => {
      tooLarge = true;
    });
    upload = storage.put(uploadKey, stream, "text/csv");
    upload.catch(() => {}); // awaited (and reported) after the form is parsed
  });

  await new Promise<void>((resolve, reject) => {
    bb.on("close", resolve);
    bb.on("error", (err) => reject(new HttpError(400, `Upload failed: ${(err as Error).message}`)));
    req.pipe(bb);
  });

  if (!upload) throw new HttpError(400, "Choose a CSV file to import");
  await upload;
  if (tooLarge) {
    await storage.delete(uploadKey).catch(() => {});
    throw new HttpError(413, `The file is larger than ${Math.round(env.importMaxBytes / 1024 / 1024)} MB`);
  }

  let departmentId: string | undefined;
  if (fields.departmentId) {
    if (!allowedDepartments(user, schema).some((d) => d._id === fields.departmentId)) {
      await storage.delete(uploadKey).catch(() => {});
      throw new HttpError(400, "You can't import into that department", { _departmentId: "Not one of your departments" });
    }
    departmentId = fields.departmentId;
  }

  const job = await createJob({
    id: jobId,
    type: "import",
    tableName: schema.tableName,
    userId: user._id,
    username: user.username,
    params: { uploadKey, departmentId, originalName },
  });
  res.status(202).json({ job: publicJob(job) });
}

const ownJob = async (req: Request) => {
  const user = currentUser(req);
  const job = await getJob(param(req, "id"));
  if (!job || (job.userId !== user._id && !isAdmin(user))) throw new HttpError(404, "Job not found");
  return job;
};

// GET /api/jobs: own jobs (admins: everyone's)
export async function listJobsHandler(req: Request, res: Response) {
  const user = currentUser(req);
  res.json(
    await listJobs({
      userId: isAdmin(user) ? null : user._id,
      page: intParam(req.query.page, 1, 1, 100_000),
      limit: intParam(req.query.limit, 25, 1, 100),
    })
  );
}

export async function getJobHandler(req: Request, res: Response) {
  res.json(publicJob(await ownJob(req)));
}

// GET /api/jobs/:id/download: the export file or the import error report
export async function downloadJobHandler(req: Request, res: Response) {
  const job = await ownJob(req);
  if (!job.fileKey) throw new HttpError(404, "This job has no file (or it has expired)");

  try {
    const object = await storage.get(job.fileKey);
    const fileName = job.fileName || `${job.type}-${job._id}.csv`;
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (object.contentLength != null) res.set("Content-Length", String(object.contentLength));
    await pipeline(object.body, res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw new HttpError(404, "The file has expired");
    throw error;
  }
}
