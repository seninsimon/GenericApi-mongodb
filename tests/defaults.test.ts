import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, setupWorld, unique } from "./helpers.js";

type Col = { name: string; default?: unknown; options?: { id: string; label: string; color: string }[] };

// Column defaults: filled in on new records when no value is given.
describe("Default values", async () => {
  const admin = await login();
  const world = await setupWorld(admin, {
    columns: [
      { name: "title", label: "Title", required: true },
      { name: "status", label: "Status", type: "choice", options: ["To do", "Doing", "Done"], default: "to do" },
      { name: "due", label: "Due", type: "date", default: "today" },
      { name: "owner", label: "Owner", type: "user", default: "$me" },
      { name: "team", label: "Team", type: "department", default: "$mine" },
      { name: "qty", label: "Qty", type: "number", default: 1 },
      { name: "urgent", label: "Urgent", type: "boolean", default: false },
      { name: "note", label: "Note", default: "n/a" },
    ],
  });
  const t = world.table;
  const me = (await world.user.get("/api/auth/me")).body;
  const myId = (me.user ?? me)._id as string;
  const today = (() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();
  const column = async (name: string): Promise<Col> =>
    (await admin.get(`/api/schema/${t}`)).body.columns.find((c: Col) => c.name === name);
  const create = async (client: typeof admin, data: object) => {
    const id = (await client.post(`/api/table/${t}`, data).expect(200)).body.data.insertedId;
    return (await admin.get(`/api/table/${t}/${id}`)).body;
  };

  it("stores defaults with the column, in canonical form", async () => {
    expect((await column("status")).default).toBe("To do");
    expect((await column("due")).default).toBe("today");
    expect((await column("urgent")).default).toBe(false);
  });

  it("fills in missing fields on new records", async () => {
    const r = await create(world.user, { title: "A" });
    expect(r).toMatchObject({ status: "To do", due: today, owner: myId, team: world.dept._id, qty: 1, urgent: false, note: "n/a" });
  });

  it("keeps fields sent empty on purpose, and given values", async () => {
    const r = await create(world.user, { title: "B", note: "", qty: null, status: "Done", due: null });
    expect(r.note).toBe("");
    expect(r.qty).toBeNull();
    expect(r.status).toBe("Done");
    expect(r.due).toBeNull();
  });

  it("leaves 'my department' empty for people in several departments", async () => {
    const other = (await admin.post("/api/departments", { name: unique("Other") })).body.department;
    const username = unique("multi").toLowerCase().slice(0, 40);
    await admin
      .post("/api/users", { username, password: "user-pass-123", roleId: world.role._id, departmentIds: [world.dept._id, other._id] })
      .expect(201);
    const multi = await login(username, "user-pass-123");
    const r = await create(multi, { title: "C" });
    expect(r.team ?? null).toBeNull();
    expect(r.owner).not.toBe(myId);
  });

  it("refuses defaults a column can't have", async () => {
    const bad = async (col: object) => (await admin.post(`/api/schema/${t}/column`, col)).body.message as string;
    expect(await bad({ name: "d2", type: "date", default: "2026-01-01" })).toMatch(/can only be "today"/);
    expect(await bad({ name: "u2", type: "user", default: "someone" })).toMatch(/person creating the record/);
    expect(await bad({ name: "c2", type: "choice", options: ["A"], default: "B" })).toMatch(/not one of its options/);
    expect(await bad({ name: "n2", type: "number", default: "lots" })).toMatch(/must be a number/);
    expect(await bad({ name: "f2", type: "file", default: "x" })).toMatch(/can't have one/);
  });

  it("follows renamed options and drops removed ones", async () => {
    const options = (await column("status")).options!;
    await admin
      .put(`/api/schema/${t}/column/status`, { options: options.map((o) => (o.label === "To do" ? { ...o, label: "Open" } : o)) })
      .expect(200);
    expect((await column("status")).default).toBe("Open");
    const renamed = (await column("status")).options!;
    await admin.put(`/api/schema/${t}/column/status`, { options: renamed.filter((o) => o.label !== "Open") }).expect(200);
    expect((await column("status")).default).toBeUndefined();
  });

  it("can be changed or cleared, and is dropped when the type changes", async () => {
    await admin.put(`/api/schema/${t}/column/note`, { default: "tbd" }).expect(200);
    expect((await column("note")).default).toBe("tbd");
    await admin.put(`/api/schema/${t}/column/note`, { type: "textarea" }).expect(200);
    expect((await column("note")).default).toBeUndefined();
    await admin.put(`/api/schema/${t}/column/qty`, { default: null }).expect(200);
    expect((await column("qty")).default).toBeUndefined();

    // the change is in the column's history
    const audit = await admin.get(`/api/audit?tableName=${t}&entity=column`);
    expect(JSON.stringify(audit.body.data.map((e: { changes: unknown }) => e.changes))).toMatch(/"default"/);
  });

  it("applies to CSV imports: missing columns get the default, empty cells stay empty", async () => {
    await admin.put(`/api/schema/${t}/column/status`, { default: "Doing" }).expect(200);
    const csv = ["Title,Status", "From file,", "Also from file,Done"].join("\n");
    const start = await world.user.upload(`/api/table/${t}/import`).attach("file", Buffer.from(csv), "d.csv");
    await drainJobs();
    expect((await world.user.get(`/api/jobs/${start.body.job._id}`)).body.result).toMatchObject({ inserted: 2 });
    const rows = (await world.user.get(`/api/table/${t}?search=file&limit=10`)).body.data as Record<string, unknown>[];
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(byTitle["From file"]).toMatchObject({ status: null, due: today, urgent: false });
    expect(byTitle["Also from file"].status).toBe("Done");
  });
});
