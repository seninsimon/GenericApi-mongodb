import { describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { login, unique } from "./helpers.js";

// What the "related records" panel relies on: a link filter ("Project is any
// of <id>") on the child table, through the normal list endpoint, so counts
// follow the viewer's departments and "Own only", and link columns are indexed.
describe("Related records (link filters)", async () => {
  const admin = await login();
  const teamA = (await admin.post("/api/departments", { name: unique("TeamA") })).body.department;
  const teamB = (await admin.post("/api/departments", { name: unique("TeamB") })).body.department;

  const projects = unique("projects");
  const tasks = unique("tasks");
  await admin.post("/api/schema", { tableName: projects, columns: [{ name: "name", label: "Name" }] }).expect(200);
  await admin
    .post("/api/schema", {
      tableName: tasks,
      columns: [
        { name: "title", label: "Title" },
        { name: "project", label: "Project", type: "relation", ref: projects },
        { name: "also_for", label: "Also for", type: "relation", ref: projects, multiple: true },
        { name: "assignee", label: "Assignee", type: "user" },
      ],
    })
    .expect(200);
  for (const t of [projects, tasks]) await admin.put(`/api/schema/${t}`, { departmentIds: [teamA._id, teamB._id] }).expect(200);

  const p1 = (await admin.post(`/api/table/${projects}`, { name: "P1", _departmentId: teamA._id })).body.data.insertedId;
  const p2 = (await admin.post(`/api/table/${projects}`, { name: "P2", _departmentId: teamA._id })).body.data.insertedId;

  const member = async (perms: object) => {
    const role = (await admin.post("/api/roles", { name: unique("R"), permissions: { [tasks]: perms, [projects]: { view: true } } }))
      .body.role;
    const username = unique("m").toLowerCase();
    const user = (await admin.post("/api/users", { username, password: "user-pass-123", roleId: role._id, departmentIds: [teamA._id] }))
      .body.user;
    return { id: user._id as string, client: await login(username, "user-pass-123") };
  };
  const ann = await member({ view: true, create: true });
  const own = await member({ view: true, own: true });

  const task = (data: object) => admin.post(`/api/table/${tasks}`, data).expect(200);
  await task({ title: "a1", project: p1, assignee: own.id, _departmentId: teamA._id });
  await task({ title: "a2", project: p1, _departmentId: teamA._id });
  await task({ title: "b1", project: p1, _departmentId: teamB._id }); // other team
  await task({ title: "x", project: p2, also_for: [p1], _departmentId: teamA._id });

  const linked = async (client: typeof admin, field: string, id: string) => {
    const f = encodeURIComponent(JSON.stringify([{ field, op: "in", value: [id] }]));
    const body = (await client.get(`/api/table/${tasks}?limit=5&filters=${f}`)).body;
    return { total: body.total, titles: body.data.map((r: { title: string }) => r.title).sort() };
  };

  it("finds records linking to a record, single or multiple links", async () => {
    expect(await linked(admin, "project", p1)).toEqual({ total: 3, titles: ["a1", "a2", "b1"] });
    expect(await linked(admin, "also_for", p1)).toEqual({ total: 1, titles: ["x"] });
    expect((await linked(admin, "project", p2)).titles).toEqual(["x"]);
  });

  it("counts only what the viewer may see", async () => {
    expect(await linked(ann.client, "project", p1)).toEqual({ total: 2, titles: ["a1", "a2"] }); // not team B's
    expect(await linked(own.client, "project", p1)).toEqual({ total: 1, titles: ["a1"] }); // Own only
  });

  it("doesn't match records linking elsewhere", async () => {
    const f = encodeURIComponent(JSON.stringify([{ field: "also_for", op: "in", value: [p2] }]));
    expect((await admin.get(`/api/table/${tasks}?filters=${f}`)).body.total).toBe(0);
  });

  it("indexes link and person columns", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'erp_data' AND tablename = $1 AND indexname LIKE '%\\_l'`,
      [tasks]
    );
    const defs = rows.map((r) => r.indexdef).join("\n");
    expect(rows.length).toBe(3); // project, also_for, assignee
    expect(defs).toMatch(/USING gin \W*data -> 'project'/);
  });

  it("cleans up", async () => {
    await admin.del(`/api/schema/${tasks}`).expect(200);
    await admin.del(`/api/schema/${projects}`).expect(200);
  });
});
