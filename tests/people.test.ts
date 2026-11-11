import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { query } from "../src/db/pool.js";
import { dataTable } from "../src/db/dataTables.js";
import { drainJobs } from "../src/jobs/worker.js";
import { anonymous, login, setupWorld, unique } from "./helpers.js";

describe('"User" columns and "Created by"', async () => {
  const admin = await login();
  const world = await setupWorld(admin, {
    columns: [
      { name: "title", label: "Title", required: true },
      { name: "assignee", label: "Assignee", type: "user" },
      { name: "reviewers", label: "Reviewers", type: "user", multiple: true },
    ],
  });
  const t = world.table;
  const me = (await world.user.get("/api/auth/me")).body.user;

  // a colleague with a full name, in the same department
  const colleagueName = unique("colleague").toLowerCase().slice(0, 40);
  const colleague = (
    await admin.post("/api/users", {
      username: colleagueName,
      fullName: "Chris Colleague",
      password: "colleague-pass-1",
      roleId: world.role._id,
      departmentIds: [world.dept._id],
    })
  ).body.user;

  it("lets anyone logged in search people by name, without exposing account details", async () => {
    const res = await world.user.get(`/api/users/options?search=${encodeURIComponent("chris colleague")}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ value: colleague._id, label: "Chris Colleague", username: colleagueName, isActive: true }]);

    const byId = await world.user.get(`/api/users/options?ids=${colleague._id},no-such-user`);
    expect(byId.body.map((o: { label: string }) => o.label)).toEqual(["Chris Colleague", "Deleted user"]);
    expect((await (await anonymous()).get("/api/users/options")).status).toBe(401);
  });

  it("stores user ids, shows names in lists, and records who created each record", async () => {
    const created = await world.user.post(`/api/table/${t}`, {
      title: "Fix the printer",
      assignee: colleague._id,
      reviewers: [colleague._id, me._id],
    });
    expect(created.status).toBe(200);
    const id = created.body.data.insertedId;

    const record = (await world.user.get(`/api/table/${t}/${id}`)).body;
    expect(record).toMatchObject({
      assignee: colleague._id,
      reviewers: [colleague._id, me._id],
      _createdById: me._id,
      _createdBy: world.username, // no full name: the username is shown
    });

    const row = (await world.user.get(`/api/table/${t}`)).body.data.find((r: { _id: string }) => r._id === id);
    expect(row).toMatchObject({
      assignee: "Chris Colleague",
      reviewers: ["Chris Colleague", world.username],
      _createdBy: world.username,
      _createdById: me._id,
    });
  });

  it("rejects unknown and deactivated people, but keeps them on existing records", async () => {
    expect((await world.user.post(`/api/table/${t}`, { title: "x", assignee: "nobody" })).body.errors.assignee).toMatch(
      /not found/
    );

    const leaverName = unique("leaver").toLowerCase().slice(0, 40);
    const leaver = (
      await admin.post("/api/users", { username: leaverName, password: "leaver-pass-1", roleId: world.role._id })
    ).body.user;
    const id = (await world.user.post(`/api/table/${t}`, { title: "Old task", assignee: leaver._id })).body.data.insertedId;
    await admin.put(`/api/users/${leaver._id}`, { isActive: false }).expect(200);

    // can't be chosen any more, and doesn't appear in the picker
    expect((await world.user.post(`/api/table/${t}`, { title: "y", assignee: leaver._id })).body.errors.assignee).toMatch(
      /deactivated/
    );
    const search = (await world.user.get(`/api/users/options?search=${leaverName}`)).body;
    expect(search).toEqual([]);
    // ...but an unrelated edit of the old record still works, and the name still shows
    expect((await world.user.put(`/api/table/${t}/${id}`, { title: "Old task (renamed)" })).status).toBe(200);
    const row = (await world.user.get(`/api/table/${t}?search=renamed`)).body.data[0];
    expect(row.assignee).toBe(leaverName);
  });

  it('filters by person, with "$me" meaning whoever is looking', async () => {
    await world.user.post(`/api/table/${t}`, { title: "Mine", assignee: me._id }).expect(200);
    const filter = (f: object) => `/api/table/${t}?filters=${encodeURIComponent(JSON.stringify([f]))}`;

    const mine = (await world.user.get(filter({ field: "assignee", op: "in", value: ["$me"] }))).body.data;
    expect(mine.map((r: { title: string }) => r.title)).toEqual(["Mine"]);

    const reviewing = (await world.user.get(filter({ field: "reviewers", op: "in", value: ["$me"] }))).body.data;
    expect(reviewing.map((r: { title: string }) => r.title)).toEqual(["Fix the printer"]);

    const createdByMe = (await world.user.get(filter({ field: "_createdBy", op: "in", value: ["$me"] }))).body;
    expect(createdByMe.total).toBeGreaterThanOrEqual(3);
    // the admin created none of them
    const createdByAdmin = (await admin.get(filter({ field: "_createdBy", op: "in", value: ["$me"] }))).body;
    expect(createdByAdmin.total).toBe(0);
  });

  it("can't change a column to or from the User type", async () => {
    expect((await admin.put(`/api/schema/${t}/column/assignee`, { type: "text" })).status).toBe(400);
    expect((await admin.put(`/api/schema/${t}/column/title`, { type: "user" })).status).toBe(400);
  });

  it("exports names and imports names, usernames or ids", async () => {
    const csv = [
      "Title,Assignee,Reviewers,Created by",
      `By name,Chris Colleague,${world.username},someone else`,
      `By username,${colleagueName.toUpperCase()},,`,
      "Unknown person,Nobody Here,,",
    ].join("\n");
    const start = await world.user.upload(`/api/table/${t}/import`).attach("file", Buffer.from(csv), "people.csv");
    await drainJobs();
    const job = (await world.user.get(`/api/jobs/${start.body.job._id}`)).body;
    // "Created by" isn't reported as an unknown column
    expect(job.result).toMatchObject({ inserted: 2, failed: 1 });
    expect(job.result.errors).toEqual([{ row: 4, message: 'Assignee: no active user "Nobody Here"' }]);

    const rows = (await world.user.get(`/api/table/${t}?search=By%20`)).body.data;
    expect(rows.map((r: { title: string; assignee: string; _createdBy: string }) => [r.title, r.assignee, r._createdBy]).sort()).toEqual([
      ["By name", "Chris Colleague", world.username],
      ["By username", "Chris Colleague", world.username],
    ]);

    const exportJob = (await world.user.post(`/api/table/${t}/export`, { search: "By name" })).body.job;
    await drainJobs();
    const lines = (await world.user.get(`/api/jobs/${exportJob._id}/download`)).text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("Title,Assignee,Reviewers,Department,Created by");
    expect(lines[1]).toBe(`By name,Chris Colleague,${world.username},${world.dept.name},${world.username}`);
  });

  it("fills in Created by for older records from the audit log (migration 003)", async () => {
    const id = (await world.user.post(`/api/table/${t}`, { title: "Before tracking" })).body.data.insertedId;
    await query(`UPDATE ${dataTable(t)} SET created_by = NULL WHERE _id = $1`, [id]);

    const sql = await readFile(new URL("../migrations/003_created_by.sql", import.meta.url), "utf8");
    await query(sql);

    const { rows } = await query<{ created_by: string }>(`SELECT created_by FROM ${dataTable(t)} WHERE _id = $1`, [id]);
    expect(rows[0].created_by).toBe(me._id);
  });
});
