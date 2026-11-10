import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// Department + role based access, end to end.
describe("access control", async () => {
  const admin = await login();

  const dev = (await admin.post("/api/departments", { name: unique("Dev") })).body.department;
  const hr = (await admin.post("/api/departments", { name: unique("HR") })).body.department;
  const sales = (await admin.post("/api/departments", { name: unique("Sales") })).body.department;

  const projects = unique("projects");
  const repos = unique("repos");
  await admin.post("/api/schema", { tableName: repos, columns: [{ name: "name", label: "Name" }] });
  await admin.post("/api/schema", {
    tableName: projects,
    columns: [
      { name: "member", label: "Member" },
      { name: "repo", label: "Repo", type: "relation", ref: repos },
    ],
  });
  await admin.put(`/api/schema/${projects}`, { departmentIds: [dev._id, hr._id] });
  await admin.put(`/api/schema/${repos}`, { departmentIds: [dev._id] });

  const editor = (
    await admin.post("/api/roles", {
      name: unique("Editor"),
      permissions: { [projects]: { create: true, edit: true }, [repos]: { view: true } },
    })
  ).body.role;
  const viewer = (await admin.post("/api/roles", { name: unique("Viewer"), permissions: { [projects]: { view: true } } })).body.role;

  const mk = async (prefix: string, roleId: string, departmentIds: string[]) => {
    const username = unique(prefix).toLowerCase();
    await admin.post("/api/users", { username, password: "user-pass-123", roleId, departmentIds }).expect(201);
    return login(username, "user-pass-123");
  };
  const alice = await mk("alice", editor._id, [dev._id]);
  const bob = await mk("bob", editor._id, [hr._id]);
  const carol = await mk("carol", viewer._id, [dev._id, hr._id]);
  const dave = await mk("dave", editor._id, [sales._id]);

  const repo = (await admin.post(`/api/table/${repos}`, { name: "hrms", _departmentId: dev._id })).body.data.insertedId;

  it("write permissions imply view", () => {
    expect(editor.permissions[projects].view).toBe(true);
  });

  it("shows each user only their tables", async () => {
    const names = (c: typeof alice) => c.get("/api/schema").then((r) => r.body.map((t: { tableName: string }) => t.tableName).sort());
    expect(await names(alice)).toEqual([projects, repos].sort());
    expect(await names(bob)).toEqual([projects]);
    expect(await names(dave)).toEqual([]);
    expect((await dave.get(`/api/table/${projects}`)).status).toBe(404);
  });

  it("files records into the user's department and isolates departments", async () => {
    const a = await alice.post(`/api/table/${projects}`, { member: "alice row", repo });
    expect(a.status).toBe(200);
    const aliceRow = a.body.data.insertedId;
    expect((await alice.get(`/api/table/${projects}/${aliceRow}`)).body._departmentId).toBe(dev._id);

    const list = await alice.get(`/api/table/${projects}`);
    expect(list.body.data[0]).toMatchObject({ member: "alice row", repo: "hrms" });
    expect(list.body.data[0]).not.toHaveProperty("_department");

    expect((await bob.get(`/api/table/${projects}`)).body.total).toBe(0);
    expect((await bob.get(`/api/table/${projects}?search=alice`)).body.total).toBe(0);
    expect((await bob.get(`/api/table/${projects}/${aliceRow}`)).status).toBe(404);
    expect((await bob.put(`/api/table/${projects}/${aliceRow}`, { member: "pwned" })).status).toBe(404);
    expect((await bob.post(`/api/table/${projects}`, { member: "x", _departmentId: dev._id })).status).toBe(400);
    expect((await alice.put(`/api/table/${projects}/${aliceRow}`, { _departmentId: hr._id })).status).toBe(400);
  });

  it("enforces role permissions", async () => {
    const row = (await alice.post(`/api/table/${projects}`, { member: "x" })).body.data.insertedId;
    expect((await alice.del(`/api/table/${projects}/${row}`)).status).toBe(403);
    expect((await alice.post(`/api/table/${repos}`, { name: "x" })).status).toBe(403);
    expect((await carol.post(`/api/table/${projects}`, { member: "x", _departmentId: dev._id })).status).toBe(403);
    for (const [method, url] of [
      ["post", "/api/schema"],
      ["get", "/api/users"],
      ["get", "/api/roles"],
      ["get", "/api/departments"],
      ["get", "/api/system-health"],
      ["get", "/api/audit"],
    ] as const) {
      const res = method === "get" ? await alice.get(url) : await alice.post(url, { tableName: "hack" });
      expect(res.status, url).toBe(403);
    }
  });

  it("shows multi-department users a Department column", async () => {
    const list = await carol.get(`/api/table/${projects}`);
    expect(list.body.data.every((r: { _department: string }) => [dev.name, hr.name].includes(r._department))).toBe(true);
  });

  it("hides relation names the user can't see", async () => {
    await bob.post(`/api/table/${projects}`, { member: "bob row" }).expect(200);
    // bob can't link to repos he can't see
    const res = await bob.post(`/api/table/${projects}`, { member: "bob row 2", repo });
    expect(res.status).toBe(400);
    expect(res.body.errors.repo).toMatch(/access/);
    expect((await bob.get(`/api/table/${repos}/options`)).status).toBe(404);
  });

  it("protects admin accounts", async () => {
    const me = (await admin.get("/api/auth/me")).body.user;
    expect((await admin.del(`/api/users/${me._id}`)).status).toBe(400);
    expect((await admin.put(`/api/users/${me._id}`, { isActive: false })).status).toBe(400);
    expect((await admin.put(`/api/users/${me._id}`, { roleId: viewer._id })).status).toBe(400);
    expect((await admin.del(`/api/roles/${editor._id}`)).status).toBe(409);
    expect((await admin.del(`/api/roles/${me.role._id}`)).status).toBe(400);
  });

  it("deleting a department unassigns its records", async () => {
    expect((await admin.del(`/api/departments/${hr._id}`)).status).toBe(200);
    const list = await admin.get(`/api/table/${projects}?limit=100`);
    expect(list.body.data.some((r: { _department: string }) => r._department === "Unassigned")).toBe(true);
    expect((await bob.get("/api/schema")).body).toEqual([]);
  });
});
