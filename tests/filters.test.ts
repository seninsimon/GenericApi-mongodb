import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, setupWorld, unique } from "./helpers.js";

describe("list filters, system sort, bulk delete, filtered export", async () => {
  const admin = await login();
  const people = unique("people");
  await admin.post("/api/schema", { tableName: people, columns: [{ name: "name", label: "Name" }] });

  const world = await setupWorld(admin, {
    columns: [
      { name: "title", label: "Title" },
      { name: "qty", label: "Qty", type: "number" },
      { name: "due", label: "Due", type: "date" },
      { name: "paid", label: "Paid", type: "boolean" },
      { name: "owner", label: "Owner", type: "relation", ref: people },
      { name: "tags", label: "Tags", type: "relation", ref: people, multiple: true },
      { name: "hidden", label: "Hidden", showInTable: false },
    ],
  });
  await admin.put(`/api/schema/${people}`, { departmentIds: [world.dept._id] });
  await admin.put(`/api/roles/${world.role._id}`, {
    permissions: { [world.table]: { view: true, create: true, edit: true, delete: true }, [people]: { view: true } },
  });
  const ann = (await admin.post(`/api/table/${people}`, { name: "Ann", _departmentId: world.dept._id })).body.data.insertedId;
  const bob = (await admin.post(`/api/table/${people}`, { name: "Bob", _departmentId: world.dept._id })).body.data.insertedId;
  const t = world.table;

  const rows = [
    { title: "Alpha invoice", qty: 5, due: "2026-01-10", paid: true, owner: ann, tags: [ann], hidden: "h1" },
    { title: "Beta order", qty: 50, due: "2026-02-20", paid: false, owner: bob, tags: [ann, bob] },
    { title: "Gamma invoice", qty: 500, due: "2026-03-30", tags: [] },
  ];
  for (const row of rows) await world.user.post(`/api/table/${t}`, row).expect(200);

  const titles = async (filters: object[], extra = "") => {
    const res = await world.user.get(`/api/table/${t}?limit=50&filters=${encodeURIComponent(JSON.stringify(filters))}${extra}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data.map((r: { title: string }) => r.title).sort();
  };

  it("returns rows keyed by column name, including hidden columns and timestamps", async () => {
    const res = await world.user.get(`/api/table/${t}?limit=50`);
    const alpha = res.body.data.find((r: { title: string }) => r.title === "Alpha invoice");
    expect(alpha).toMatchObject({ qty: 5, owner: "Ann", tags: ["Ann"], hidden: "h1", paid: true });
    expect(alpha._createdAt).toBeTruthy();
    expect(alpha._updatedAt).toBeTruthy();
  });

  it("filters text, numbers, dates and booleans", async () => {
    expect(await titles([{ field: "title", op: "contains", value: "INVOICE" }])).toEqual(["Alpha invoice", "Gamma invoice"]);
    expect(await titles([{ field: "title", op: "notContains", value: "invoice" }])).toEqual(["Beta order"]);
    expect(await titles([{ field: "qty", op: "gte", value: 50 }])).toEqual(["Beta order", "Gamma invoice"]);
    expect(await titles([{ field: "qty", op: "between", value: 1, value2: 60 }])).toEqual(["Alpha invoice", "Beta order"]);
    expect(await titles([{ field: "due", op: "before", value: "2026-02-20" }])).toEqual(["Alpha invoice"]);
    expect(await titles([{ field: "due", op: "between", value: "2026-02-01", value2: "2026-12-31" }])).toEqual([
      "Beta order",
      "Gamma invoice",
    ]);
    expect(await titles([{ field: "paid", op: "isTrue" }])).toEqual(["Alpha invoice"]);
    expect(await titles([{ field: "paid", op: "isEmpty" }])).toEqual(["Gamma invoice"]);
  });

  it("filters relations (single and multiple) and empties", async () => {
    expect(await titles([{ field: "owner", op: "in", value: [bob] }])).toEqual(["Beta order"]);
    expect(await titles([{ field: "tags", op: "in", value: [ann] }])).toEqual(["Alpha invoice", "Beta order"]);
    expect(await titles([{ field: "tags", op: "isEmpty" }])).toEqual(["Gamma invoice"]);
    expect(await titles([{ field: "owner", op: "isNotEmpty" }])).toEqual(["Alpha invoice", "Beta order"]);
  });

  it("combines filters with search and department", async () => {
    expect(
      await titles([{ field: "qty", op: "gt", value: 1 }, { field: "_department", op: "in", value: [world.dept._id] }], "&search=gamma")
    ).toEqual(["Gamma invoice"]);
  });

  it("rejects invalid filters", async () => {
    for (const bad of [
      "not json",
      JSON.stringify([{ field: "nope", op: "eq", value: 1 }]),
      JSON.stringify([{ field: "qty", op: "contains", value: "x" }]),
      JSON.stringify([{ field: "qty", op: "gt", value: "abc" }]),
      JSON.stringify([{ field: "due", op: "after", value: "yesterday" }]),
      JSON.stringify([{ field: "owner", op: "in", value: [] }]),
    ]) {
      expect((await world.user.get(`/api/table/${t}?filters=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
  });

  it("sorts by system timestamps", async () => {
    const asc = await world.user.get(`/api/table/${t}?sort=_createdAt&order=asc&limit=50`);
    expect(asc.body.data[0].title).toBe("Alpha invoice");
    const updated = asc.body.data.find((r: { title: string }) => r.title === "Beta order")._id;
    await world.user.put(`/api/table/${t}/${updated}`, { qty: 51 }).expect(200);
    const byUpdate = await world.user.get(`/api/table/${t}?sort=_updatedAt&order=desc&limit=1`);
    expect(byUpdate.body.data[0].title).toBe("Beta order");
  });

  it("returns record metadata on the single-record endpoint", async () => {
    const id = (await world.user.get(`/api/table/${t}?limit=1`)).body.data[0]._id;
    const record = (await world.user.get(`/api/table/${t}/${id}`)).body;
    expect(record).toMatchObject({ _departmentId: world.dept._id, _departmentName: world.dept.name });
    expect(record._createdAt).toBeTruthy();
  });

  it("exports only the filtered view", async () => {
    const job = (
      await world.user.post(`/api/table/${t}/export`, { filters: [{ field: "title", op: "contains", value: "invoice" }] })
    ).body.job;
    await drainJobs();
    const done = (await world.user.get(`/api/jobs/${job._id}`)).body;
    expect(done.result.rows).toBe(2);
  });

  it("bulk deletes within the user's departments, with an audit entry each", async () => {
    const all = (await world.user.get(`/api/table/${t}?limit=50`)).body.data.map((r: { _id: string }) => r._id);
    const res = await world.user.post(`/api/table/${t}/bulk-delete`, { ids: [...all, "not-a-record"] });
    expect(res.body).toMatchObject({ deleted: all.length, notFound: 1 });
    expect((await world.user.get(`/api/table/${t}`)).body.total).toBe(0);
    const audit = await admin.get(`/api/audit?tableName=${t}&action=delete&limit=50`);
    expect(audit.body.total).toBe(all.length);
    expect((await world.user.post(`/api/table/${t}/bulk-delete`, { ids: [] })).status).toBe(400);
  });
});
