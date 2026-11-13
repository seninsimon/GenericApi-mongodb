import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, unique } from "./helpers.js";

// "Visible to" several departments: a project for Engineering and Design.
describe('"Visible to" several departments', async () => {
  const admin = await login();
  const dept = async (name: string) => (await admin.post("/api/departments", { name: unique(name) })).body.department;
  const eng = await dept("Eng");
  const design = await dept("Design");
  const ops = await dept("Ops");

  const projects = unique("projects");
  await admin.post("/api/schema", { tableName: projects, columns: [{ name: "name", label: "Name", required: true }] }).expect(200);
  await admin.put(`/api/schema/${projects}`, { departmentIds: [eng._id, design._id, ops._id] }).expect(200);
  const role = (
    await admin.post("/api/roles", {
      name: unique("Staff"),
      permissions: { [projects]: { view: true, create: true, edit: true, delete: true } },
    })
  ).body.role;
  const person = async (name: string, departmentIds: string[]) => {
    const username = unique(name).toLowerCase();
    await admin.post("/api/users", { username, password: "pass-123-pass", roleId: role._id, departmentIds }).expect(201);
    return login(username, "pass-123-pass");
  };
  const asha = await person("asha", [eng._id]); // Engineering
  const dev = await person("dev", [design._id]); // Design
  const omar = await person("omar", [ops._id]); // Ops

  const names = async (who: typeof asha, query = "") =>
    (await who.get(`/api/table/${projects}?limit=100${query}`)).body.data.map((r: { name: string }) => r.name);

  let launch: string;

  it("a record shared with two departments is seen by both, and nobody else", async () => {
    launch = (await asha.post(`/api/table/${projects}`, { name: "Launch", _departmentIds: [eng._id, design._id] }).expect(200)).body
      .data.insertedId;
    await asha.post(`/api/table/${projects}`, { name: "Eng only" }).expect(200); // her one department, as before

    expect(await names(asha)).toEqual(expect.arrayContaining(["Launch", "Eng only"]));
    expect(await names(dev)).toEqual(["Launch"]);
    expect(await names(omar)).toEqual([]);
    expect((await omar.get(`/api/table/${projects}/${launch}`)).status).toBe(404);

    const record = (await dev.get(`/api/table/${projects}/${launch}`)).body;
    expect(record).toMatchObject({ _departmentId: eng._id, _departmentIds: [eng._id, design._id], _departmentName: `${eng.name}, ${design.name}` });
    const row = (await dev.get(`/api/table/${projects}`)).body.data[0];
    expect(row).toMatchObject({ _department: `${eng.name}, ${design.name}`, _departmentIds: [eng._id, design._id] });
  });

  it("must include one of your own departments, and only the table's departments", async () => {
    const away = await asha.post(`/api/table/${projects}`, { name: "x", _departmentIds: [design._id] });
    expect(away.status).toBe(400);
    expect(away.body.errors._departmentId).toMatch(/at least one of your own/);

    const stranger = await dept("Stranger"); // not one of the table's departments
    expect((await asha.post(`/api/table/${projects}`, { name: "x", _departmentIds: [eng._id, stranger._id] })).status).toBe(400);
    expect((await asha.post(`/api/table/${projects}`, { name: "x", _departmentIds: [] })).status).toBe(400);
  });

  it("the other department can edit it; re-sending the same list (any order) changes nothing", async () => {
    await dev.put(`/api/table/${projects}/${launch}`, { name: "Launch v2", _departmentIds: [design._id, eng._id] }).expect(200);
    expect((await asha.get(`/api/table/${projects}/${launch}`)).body).toMatchObject({ name: "Launch v2", _departmentIds: [eng._id, design._id] });

    // Design shares it with Ops too, then Engineering takes Design off
    await dev.put(`/api/table/${projects}/${launch}`, { _departmentIds: [eng._id, design._id, ops._id] }).expect(200);
    expect(await names(omar)).toEqual(["Launch v2"]);
    await asha.put(`/api/table/${projects}/${launch}`, { _departmentIds: [eng._id, ops._id] }).expect(200);
    expect(await names(dev)).toEqual([]);

    const audit = (await admin.get(`/api/audit?tableName=${projects}&action=update&limit=10`)).body.data;
    expect(audit[0].changes._department).toEqual({ from: `${eng.name}, ${design.name}, ${ops.name}`, to: `${eng.name}, ${ops.name}` });
  });

  it("filtering by department finds records shared with it", async () => {
    const filter = encodeURIComponent(JSON.stringify([{ field: "_department", op: "in", value: [ops._id] }]));
    expect(await names(admin, `&filters=${filter}`)).toEqual(["Launch v2"]);
  });

  it('exports and imports "Visible to" as names separated by ";"', async () => {
    const start = await asha.post(`/api/table/${projects}/export`);
    await drainJobs();
    const lines = (await asha.get(`/api/jobs/${start.body.job._id}/download`)).text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("Name,Visible to,Created by");
    expect(lines.find((l) => l.startsWith("Launch v2"))).toContain(`${eng.name}; ${ops.name}`);

    const csv = ["Name,Visible to", `Shared,${eng.name}; ${design.name.toUpperCase()}`, `Not mine,${design.name}`, "Unknown,Nowhere"].join("\n");
    const job = (await asha.upload(`/api/table/${projects}/import`).attach("file", Buffer.from(csv), "p.csv")).body.job;
    await drainJobs();
    const result = (await asha.get(`/api/jobs/${job._id}`)).body.result;
    expect(result).toMatchObject({ inserted: 1, failed: 2 });
    expect(result.errors.map((e: { message: string }) => e.message)).toEqual([
      expect.stringMatching(/must include one of your departments/),
      expect.stringMatching(/isn't a department of this table/),
    ]);
    expect(await names(dev)).toEqual(["Shared"]);
  });

  it("deleting a department takes it off; the next one becomes the first", async () => {
    const temp = await dept("Temp");
    await admin.put(`/api/schema/${projects}`, { departmentIds: [eng._id, design._id, ops._id, temp._id] }).expect(200);
    const id = (await admin.post(`/api/table/${projects}`, { name: "Temp first", _departmentIds: [temp._id, design._id] })).body.data
      .insertedId;
    await admin.put(`/api/table/${projects}/${launch}`, { _departmentIds: [eng._id, temp._id, ops._id] }).expect(200);

    await admin.del(`/api/departments/${temp._id}`).expect(200);
    expect((await admin.get(`/api/table/${projects}/${id}`)).body._departmentIds).toEqual([design._id]);
    expect((await admin.get(`/api/table/${projects}/${launch}`)).body._departmentIds).toEqual([eng._id, ops._id]);
    expect(await names(dev)).toEqual(expect.arrayContaining(["Temp first"]));
  });
});
