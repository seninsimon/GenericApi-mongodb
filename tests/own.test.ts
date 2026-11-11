import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, unique } from "./helpers.js";

// Roles can limit a table to "own records only": records the user created, or
// where they're picked in a "User" column.
describe('"Own only" permission', async () => {
  const admin = await login();
  const dept = (await admin.post("/api/departments", { name: unique("Staff") })).body.department;

  const employees = unique("employees");
  await admin
    .post("/api/schema", {
      tableName: employees,
      columns: [
        { name: "title", label: "Title", required: true },
        { name: "employee", label: "Employee", type: "user" },
        { name: "reviewers", label: "Reviewers", type: "user", multiple: true },
      ],
    })
    .expect(200);
  await admin.put(`/api/schema/${employees}`, { departmentIds: [dept._id] }).expect(200);

  // another table linking to it, to check link dropdowns and names
  const notes = unique("notes");
  await admin.post("/api/schema", {
    tableName: notes,
    columns: [
      { name: "text", label: "Text" },
      { name: "about", label: "About", type: "relation", ref: employees },
    ],
  });
  await admin.put(`/api/schema/${notes}`, { departmentIds: [dept._id] }).expect(200);

  const staffRole = (
    await admin.post("/api/roles", {
      name: unique("Staff"),
      permissions: {
        [employees]: { view: true, edit: true, own: true },
        [notes]: { view: true, create: true },
      },
    })
  ).body.role;
  const hrRole = (
    await admin.post("/api/roles", { name: unique("HR"), permissions: { [employees]: { view: true, edit: true } } })
  ).body.role;

  const mk = async (prefix: string, roleId: string) => {
    const username = unique(prefix).toLowerCase();
    const user = (
      await admin.post("/api/users", { username, password: "user-pass-123", roleId, departmentIds: [dept._id] })
    ).body.user;
    return { id: user._id as string, client: await login(username, "user-pass-123") };
  };
  const senin = await mk("senin", staffRole._id);
  const ebin = await mk("ebin", staffRole._id);
  const hr = await mk("hr", hrRole._id);

  const add = async (data: object) => (await admin.post(`/api/table/${employees}`, data)).body.data.insertedId as string;
  const seninRow = await add({ title: "Senin's record", employee: senin.id });
  const ebinRow = await add({ title: "Ebin's record", employee: ebin.id });
  const reviewRow = await add({ title: "Senin reviews this", employee: ebin.id, reviewers: [senin.id] });

  it("keeps the permission on the role", async () => {
    const role = (await admin.get("/api/roles")).body.find((r: { _id: string }) => r._id === staffRole._id);
    expect(role.permissions[employees]).toMatchObject({ view: true, edit: true, own: true });
    expect((await senin.client.get(`/api/schema/${employees}`)).body.permissions).toMatchObject({ view: true, own: true });
  });

  it("lists only the user's own records; others still see everything", async () => {
    const titles = async (c: typeof admin) =>
      (await c.get(`/api/table/${employees}`)).body.data.map((r: { title: string }) => r.title).sort();
    expect(await titles(senin.client)).toEqual(["Senin reviews this", "Senin's record"]);
    expect(await titles(ebin.client)).toEqual(["Ebin's record", "Senin reviews this"]);
    expect(await titles(hr.client)).toEqual(["Ebin's record", "Senin reviews this", "Senin's record"]);
  });

  it("hides other people's records everywhere: open, edit, history", async () => {
    expect((await senin.client.get(`/api/table/${employees}/${seninRow}`)).status).toBe(200);
    expect((await senin.client.get(`/api/table/${employees}/${ebinRow}`)).status).toBe(404);
    expect((await senin.client.put(`/api/table/${employees}/${ebinRow}`, { title: "hacked" })).status).toBe(404);
    expect((await senin.client.put(`/api/table/${employees}/${seninRow}`, { title: "Senin's record" })).status).toBe(200);
    expect((await senin.client.get(`/api/audit?tableName=${employees}&recordId=${ebinRow}`)).status).toBe(404);
  });

  it("limits link dropdowns and names in other tables", async () => {
    const options = (await senin.client.get(`/api/table/${employees}/options`)).body.map((o: { value: string }) => o.value);
    expect(options.sort()).toEqual([reviewRow, seninRow].sort());

    // linking to someone else's record is refused
    const res = await senin.client.post(`/api/table/${notes}`, { text: "x", about: ebinRow });
    expect(res.body.errors?.about).toMatch(/not found/);
  });

  it("shows people their own records even when another department keeps them", async () => {
    // HR keeps a record about Senin "visible to HR"; Senin isn't in HR
    const hrDept = (await admin.post("/api/departments", { name: unique("HR") })).body.department;
    await admin.put(`/api/schema/${employees}`, { departmentIds: [dept._id, hrDept._id] }).expect(200);
    const id = (
      await admin.post(`/api/table/${employees}`, { title: "Kept by HR", employee: senin.id, _departmentId: hrDept._id })
    ).body.data.insertedId;
    expect((await senin.client.get(`/api/table/${employees}/${id}`)).status).toBe(200);
    // ...but not other people's HR records
    const other = (
      await admin.post(`/api/table/${employees}`, { title: "Ebin at HR", employee: ebin.id, _departmentId: hrDept._id })
    ).body.data.insertedId;
    expect((await senin.client.get(`/api/table/${employees}/${other}`)).status).toBe(404);
    await admin.del(`/api/table/${employees}/${id}`).expect(200);
    await admin.del(`/api/table/${employees}/${other}`).expect(200);
    await admin.put(`/api/schema/${employees}`, { departmentIds: [dept._id] }).expect(200);
  });

  it("counts records the user created as theirs", async () => {
    const creatorRole = (
      await admin.post("/api/roles", { name: unique("Creator"), permissions: { [employees]: { create: true, own: true } } })
    ).body.role;
    const maker = await mk("maker", creatorRole._id);
    const id = (await maker.client.post(`/api/table/${employees}`, { title: "Made by me", employee: ebin.id })).body.data
      .insertedId;
    const rows = (await maker.client.get(`/api/table/${employees}`)).body.data;
    expect(rows.map((r: { _id: string }) => r._id)).toEqual([id]);
  });

  it("exports only the user's own records", async () => {
    const job = (await senin.client.post(`/api/table/${employees}/export`)).body.job;
    await drainJobs();
    const lines = (await senin.client.get(`/api/jobs/${job._id}/download`)).text.trim().split(/\r?\n/);
    expect(lines.length).toBe(3); // header + 2 own records
  });
});
