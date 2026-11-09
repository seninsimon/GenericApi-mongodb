import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, setupWorld, unique } from "./helpers.js";

const csvOf = (text: string) => Buffer.from(text, "utf8");

describe("CSV export / import jobs", async () => {
  const admin = await login();
  const people = unique("people");
  await admin.post("/api/schema", { tableName: people, columns: [{ name: "name", label: "Name" }] });

  const world = await setupWorld(admin, {
    columns: [
      { name: "title", label: "Title", required: true },
      { name: "qty", label: "Qty", type: "number" },
      { name: "ok", label: "OK", type: "boolean" },
      { name: "owner", label: "Owner", type: "relation", ref: people },
    ],
  });
  await admin.put(`/api/schema/${people}`, { departmentIds: [world.dept._id] });
  await admin.put(`/api/roles/${world.role._id}`, {
    permissions: { [world.table]: { create: true }, [people]: { view: true } },
  });
  const ann = (await admin.post(`/api/table/${people}`, { name: "Ann", _departmentId: world.dept._id })).body.data.insertedId;
  const t = world.table;

  it("exports a table to CSV with labels, departments and formula-safe cells", async () => {
    await world.user.post(`/api/table/${t}`, { title: "=HYPERLINK(evil)", qty: -5, ok: true, owner: ann }).expect(200);
    const start = await world.user.post(`/api/table/${t}/export`);
    expect(start.status).toBe(202);
    expect(start.body.job.status).toBe("queued");

    await drainJobs();
    const job = (await world.user.get(`/api/jobs/${start.body.job._id}`)).body;
    expect(job).toMatchObject({ status: "done", hasFile: true, result: { rows: 1 } });

    const file = await world.user.get(`/api/jobs/${job._id}/download`);
    expect(file.headers["content-disposition"]).toMatch(/attachment/);
    const lines = file.text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("Title,Qty,OK,Owner,Department");
    expect(lines[1]).toBe(`'=HYPERLINK(evil),-5,true,Ann,${world.dept.name}`);
  });

  it("imports CSV rows, resolving relations by label and reporting bad rows", async () => {
    const csv = [
      "Title,Qty,OK,Owner,Unknown",
      "Imported one,3,yes,Ann,x",
      ",4,no,,x", // missing required title
      "Bad qty,lots,1,,x",
      "No such owner,1,0,Nobody,x",
      "Imported two,,,Ann,x",
    ].join("\n");
    const start = await world.user.upload(`/api/table/${t}/import`).attach("file", csvOf(csv), "data.csv");
    expect(start.status).toBe(202);

    await drainJobs();
    const job = (await world.user.get(`/api/jobs/${start.body.job._id}`)).body;
    expect(job.status).toBe("done");
    expect(job.result).toMatchObject({ rows: 5, inserted: 2, failed: 3 });
    expect(job.result.errors[0].message).toMatch(/Unknown/);
    expect(job.result.errors.map((e: { row: number }) => e.row)).toEqual([1, 3, 4, 5]);
    expect(job.hasFile).toBe(true); // error report

    const list = await world.user.get(`/api/table/${t}?search=Imported`);
    expect(list.body.total).toBe(2);
    expect(list.body.data.map((r: { Owner: string }) => r.Owner)).toEqual(["Ann", "Ann"]);

    const audit = await admin.get(`/api/audit?tableName=${t}&action=import`);
    expect(audit.body.data[0].changes).toMatchObject({ inserted: 2, failed: 3 });
  });

  it("checks permissions when queuing and when running", async () => {
    const viewerRole = (await admin.post("/api/roles", { name: unique("V"), permissions: { [t]: { view: true } } })).body.role;
    const username = unique("v").toLowerCase();
    await admin.post("/api/users", { username, password: "user-pass-123", roleId: viewerRole._id, departmentIds: [world.dept._id] });
    const viewer = await login(username, "user-pass-123");

    expect((await viewer.upload(`/api/table/${t}/import`).attach("file", csvOf("Title\nx"), "a.csv")).status).toBe(403);
    // someone else's job is invisible
    const job = (await world.user.post(`/api/table/${t}/export`)).body.job;
    expect((await viewer.get(`/api/jobs/${job._id}`)).status).toBe(404);
    expect((await viewer.get(`/api/jobs/${job._id}/download`)).status).toBe(404);
    expect((await admin.get(`/api/jobs/${job._id}`)).status).toBe(200);
    await drainJobs();
  });

  it("lists the user's own jobs", async () => {
    const res = await world.user.get("/api/jobs");
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.data.every((j: { userId: string }) => j.userId === res.body.data[0].userId)).toBe(true);
  });
});
