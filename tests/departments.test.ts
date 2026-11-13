import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, unique } from "./helpers.js";

describe('"Department" columns and "Visible to"', async () => {
  const admin = await login();
  const sales = (await admin.post("/api/departments", { name: unique("Sales") })).body.department;
  const ops = (await admin.post("/api/departments", { name: unique("Ops") })).body.department;

  // a staff list: "Works in" is data, the table itself is shared with Sales only
  const staff = unique("staff");
  await admin
    .post("/api/schema", {
      tableName: staff,
      columns: [
        { name: "name", label: "Name", required: true },
        { name: "works_in", label: "Works in", type: "department" },
        { name: "covers", label: "Covers", type: "department", multiple: true },
      ],
    })
    .expect(200);

  const role = (await admin.post("/api/roles", { name: unique("Staff"), permissions: { [staff]: { view: true, create: true, edit: true } } })).body.role;
  const username = unique("sam").toLowerCase();
  await admin.post("/api/users", { username, password: "sam-pass-123", roleId: role._id, departmentIds: [sales._id] }).expect(201);

  it("records added before a table is shared join its first department", async () => {
    // not shared yet: the admin's record is admins-only
    const id = (await admin.post(`/api/table/${staff}`, { name: "Early bird" })).body.data.insertedId;
    expect((await admin.get(`/api/table/${staff}/${id}`)).body._departmentId).toBeNull();

    const shared = await admin.put(`/api/schema/${staff}`, { departmentIds: [sales._id] });
    expect(shared.body.moved).toBe(1);
    expect((await admin.get(`/api/table/${staff}/${id}`)).body._departmentName).toBe(sales.name);
  });

  it('shows "Visible to" only when the table is shared with several departments', async () => {
    const sam = await login(username, "sam-pass-123");
    // one department: no column, for the admin or the user
    expect((await admin.get(`/api/table/${staff}`)).body.data[0]).not.toHaveProperty("_department");
    expect((await sam.get(`/api/table/${staff}`)).body.data[0]).not.toHaveProperty("_department");

    await admin.put(`/api/schema/${staff}`, { departmentIds: [sales._id, ops._id] }).expect(200);
    expect((await admin.get(`/api/table/${staff}`)).body.data[0]._department).toBe(sales.name);
    // Sam is only in Sales, but records may be shared with Ops too, so he sees it as well
    expect((await sam.get(`/api/table/${staff}`)).body.data[0]._department).toBe(sales.name);
    await admin.put(`/api/schema/${staff}`, { departmentIds: [sales._id] }).expect(200);
  });

  it("stores department ids, shows names, and rejects unknown departments", async () => {
    const sam = await login(username, "sam-pass-123");
    expect((await sam.post(`/api/table/${staff}`, { name: "x", works_in: "nope" })).body.errors.works_in).toMatch(/not found/);

    const id = (await sam.post(`/api/table/${staff}`, { name: "Sam", works_in: ops._id, covers: [sales._id, ops._id] })).body
      .data.insertedId;
    expect((await sam.get(`/api/table/${staff}/${id}`)).body).toMatchObject({ works_in: ops._id, covers: [sales._id, ops._id] });
    const row = (await sam.get(`/api/table/${staff}?search=Sam`)).body.data.find((r: { _id: string }) => r._id === id);
    expect(row).toMatchObject({ works_in: ops.name, covers: [sales.name, ops.name] });

    // the picker list is open to every logged-in user
    const options = (await sam.get("/api/departments/options")).body.map((o: { label: string }) => o.label);
    expect(options).toEqual(expect.arrayContaining([sales.name, ops.name]));
  });

  it('filters by "My departments"', async () => {
    const sam = await login(username, "sam-pass-123"); // in Sales
    await sam.post(`/api/table/${staff}`, { name: "Sally", works_in: sales._id }).expect(200);
    const filter = encodeURIComponent(JSON.stringify([{ field: "works_in", op: "in", value: ["$mine"] }]));
    const names = (await sam.get(`/api/table/${staff}?filters=${filter}`)).body.data.map((r: { name: string }) => r.name);
    expect(names).toEqual(["Sally"]);
  });

  it("imports department names; the access column also accepts the old header", async () => {
    const sam = await login(username, "sam-pass-123");
    const csv = ["Name,Works in,Department", `Imported,${ops.name.toUpperCase()},`, "Bad,No Such Team,"].join("\n");
    const start = await sam.upload(`/api/table/${staff}/import`).attach("file", Buffer.from(csv), "staff.csv");
    await drainJobs();
    const job = (await sam.get(`/api/jobs/${start.body.job._id}`)).body;
    expect(job.result).toMatchObject({ inserted: 1, failed: 1 });
    expect(job.result.errors).toEqual([{ row: 3, message: 'Works in: no department "No Such Team"' }]);
    const row = (await sam.get(`/api/table/${staff}?search=Imported`)).body.data[0];
    expect(row.works_in).toBe(ops.name);
  });

  it("can't change a Department column's type", async () => {
    expect((await admin.put(`/api/schema/${staff}/column/works_in`, { type: "text" })).status).toBe(400);
  });
});
