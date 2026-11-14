import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// Selecting rows and setting one field on all of them, with the same rules as
// editing one record.
describe("Bulk update", async () => {
  const admin = await login();
  const dept = async (name: string) => (await admin.post("/api/departments", { name: unique(name) })).body.department;
  const eng = await dept("Eng");
  const hr = await dept("HR");
  const table = unique("tasks");
  await admin.post("/api/schema", {
    tableName: table,
    byDepartment: true,
    columns: [
      { name: "title", label: "Title", required: true },
      { name: "status", label: "Status", type: "choice", options: [{ label: "Open" }, { label: "Doing" }, { label: "Done" }] },
      { name: "assignee", label: "Assignee", type: "user" },
      { name: "hours", label: "Hours", type: "number" },
      { name: "ref", label: "Ref", type: "autonumber", autonumber: { prefix: "T-" } },
      { name: "double", label: "Double", type: "formula", formula: { expression: "{hours} * 2" } },
    ],
  }).expect(200);
  await admin.put(`/api/schema/${table}`, { departmentIds: [eng._id, hr._id] }).expect(200);

  const editor = (await admin.post("/api/roles", { name: unique("Editor"), permissions: { [table]: { view: true, create: true, edit: true } } })).body.role;
  const viewer = (await admin.post("/api/roles", { name: unique("Viewer"), permissions: { [table]: { view: true } } })).body.role;
  const person = async (name: string, roleId: string, departmentIds: string[]) => {
    const username = unique(name).toLowerCase();
    const res = await admin.post("/api/users", { username, fullName: name, email: `${username}@example.com`, password: "pass-123-pass", roleId, departmentIds }).expect(201);
    return { id: res.body.user._id as string, client: await login(username, "pass-123-pass") };
  };
  const sam = await person("Sam", editor._id, [eng._id]);
  const hana = await person("Hana", editor._id, [eng._id]);
  const vic = await person("Vic", viewer._id, [eng._id]);

  const add = async (title: string, departmentId: string) =>
    (await admin.post(`/api/table/${table}`, { title, status: "Open", hours: 2, _departmentIds: [departmentId] }).expect(200)).body.data.insertedId as string;
  const a = await add("Write the brochure", eng._id);
  const b = await add("Call the printer", eng._id);
  const c = await add("Book the hall", eng._id);
  const secret = await add("HR only", hr._id);
  const get = async (id: string) => (await admin.get(`/api/table/${table}/${id}`).expect(200)).body;
  const bulk = (who: typeof admin, body: object) => who.post(`/api/table/${table}/bulk-update`, body);

  it("sets one field on all the selected records", async () => {
    const res = await bulk(sam.client, { ids: [a, b, c], field: "status", value: "Doing" }).expect(200);
    expect(res.body).toMatchObject({ updated: 3, skipped: [] });
    for (const id of [a, b, c]) expect((await get(id)).status).toBe("Doing");
    // the audit log has each change
    const history = (await admin.get(`/api/audit?tableName=${table}&recordId=${a}`)).body;
    expect(JSON.stringify(history)).toContain("Doing");
  });

  it("numbers work, and formulas follow", async () => {
    await bulk(sam.client, { ids: [a, b], field: "hours", value: 5 }).expect(200);
    expect(await get(a)).toMatchObject({ hours: 5, double: 10 });
  });

  it("people get told when they're assigned", async () => {
    await bulk(sam.client, { ids: [a, b], field: "assignee", value: hana.id }).expect(200);
    const titles = ((await hana.client.get("/api/notifications")).body.items as { title: string }[]).map((n) => n.title);
    expect(titles.filter((t) => t.includes("Assignee")).length).toBeGreaterThanOrEqual(2);
  });

  it("only fields that make sense, and required ones can't be cleared", async () => {
    expect((await bulk(sam.client, { ids: [a], field: "ref", value: "T-9" })).status).toBe(400); // auto-number
    expect((await bulk(sam.client, { ids: [a], field: "double", value: 3 })).status).toBe(400); // formula
    expect((await bulk(sam.client, { ids: [a], field: "nope", value: 1 })).status).toBe(400);
    const res = await bulk(sam.client, { ids: [a], field: "title", value: "" });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Title is required, so it can't be cleared");
    expect((await bulk(sam.client, { ids: [], field: "status", value: "Done" })).status).toBe(400);
  });

  it("optional fields can be cleared", async () => {
    await bulk(sam.client, { ids: [a], field: "assignee", value: null }).expect(200);
    expect((await get(a)).assignee ?? null).toBeNull();
  });

  it("records you can't change are skipped and listed; the rest are saved", async () => {
    const res = await bulk(sam.client, { ids: [c, secret], field: "status", value: "Done" }).expect(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toEqual([{ id: secret, message: "Not found, or you can't edit it" }]);
    expect((await get(c)).status).toBe("Done");
    expect((await get(secret)).status).toBe("Open"); // Sam can't see HR's record
  });

  it("a value that isn't one of the options is refused", async () => {
    const res = await bulk(sam.client, { ids: [a, b], field: "status", value: "Maybe" }).expect(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.skipped).toHaveLength(2);
    expect(res.body.skipped[0].message).toMatch(/"Maybe" is not an option for Status/);
  });

  it("needs edit permission", async () => {
    expect((await bulk(vic.client, { ids: [a], field: "status", value: "Done" })).status).toBe(403);
  });
});
