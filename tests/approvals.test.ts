import { describe, expect, it } from "vitest";
import { setupWorld, login, unique } from "./helpers.js";

// Approval steps: choice options only some roles may choose.
describe("Approval steps", async () => {
  const admin = await login();
  const world = await setupWorld(admin, {
    columns: [
      { name: "title", label: "Title" },
      { name: "status", label: "Status", type: "choice", options: ["Pending", "Approved"], default: "Pending" },
    ],
  });
  const t = world.table;
  const managerRole = (await admin.post("/api/roles", { name: unique("Manager"), permissions: { [t]: { view: true, create: true, edit: true } } })).body.role;
  const username = unique("boss").toLowerCase();
  await admin.post("/api/users", { username, password: "user-pass-123", roleId: managerRole._id, departmentIds: [world.dept._id] });
  const boss = await login(username, "user-pass-123");

  // "Approved": only the manager role
  const options = (await admin.get(`/api/schema/${t}`)).body.columns.find((c: { name: string }) => c.name === "status").options;
  await admin
    .put(`/api/schema/${t}/column/status`, {
      options: options.map((o: { label: string }) => (o.label === "Approved" ? { ...o, roles: [managerRole._id] } : o)),
    })
    .expect(200);

  const id = (await world.user.post(`/api/table/${t}`, { title: "Leave" }).expect(200)).body.data.insertedId;

  it("keeps the roles on the option", async () => {
    const status = (await admin.get(`/api/schema/${t}`)).body.columns.find((c: { name: string }) => c.name === "status");
    expect(status.options.find((o: { label: string }) => o.label === "Approved").roles).toEqual([managerRole._id]);
  });

  it("stops others from choosing it", async () => {
    const res = await world.user.put(`/api/table/${t}/${id}`, { status: "Approved" });
    expect(res.status).toBe(400);
    expect(res.body.errors.status).toMatch(/Only some roles can set Status to "Approved"/);
    expect((await world.user.post(`/api/table/${t}`, { title: "x", status: "Approved" })).status).toBe(400);
  });

  it("lets the role (and admins) choose it", async () => {
    await boss.put(`/api/table/${t}/${id}`, { status: "Approved" }).expect(200);
    await admin.put(`/api/table/${t}/${id}`, { status: "Pending" }).expect(200);
    await admin.put(`/api/table/${t}/${id}`, { status: "Approved" }).expect(200);
  });

  it("doesn't block other edits of an approved record", async () => {
    await world.user.put(`/api/table/${t}/${id}`, { title: "Leave (edited)", status: "Approved" }).expect(200);
  });
});
