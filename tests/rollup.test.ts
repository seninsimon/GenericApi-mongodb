import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, unique } from "./helpers.js";

// Roll-up columns: totals over linked records, kept current as they change.
describe("Roll-up columns", async () => {
  const admin = await login();
  const projects = unique("projects");
  const tasks = unique("tasks");
  const logs = unique("logs");
  await admin.post("/api/schema", { tableName: projects, columns: [{ name: "name", label: "Name" }] }).expect(200);
  await admin
    .post("/api/schema", {
      tableName: tasks,
      columns: [
        { name: "title", label: "Title" },
        { name: "project", label: "Project", type: "relation", ref: projects },
        { name: "status", label: "Status", type: "choice", options: ["To do", "Done"] },
        { name: "estimate", label: "Estimate", type: "number" },
        { name: "due", label: "Due", type: "date" },
      ],
    })
    .expect(200);
  await admin
    .post("/api/schema", {
      tableName: logs,
      columns: [
        { name: "task", label: "Task", type: "relation", ref: tasks },
        { name: "hours", label: "Hours", type: "number" },
      ],
    })
    .expect(200);
  const total = (name: string, label: string, rollup: object) => ({ name, label, type: "rollup", rollup });
  await admin.post(`/api/schema/${tasks}/column`, total("hours", "Hours", { from: logs, via: "task", fn: "sum", field: "hours" })).expect(200);
  for (const column of [
    total("hours", "Hours", { from: tasks, via: "project", fn: "sum", field: "hours" }), // a total of totals
    total("open", "Open tasks", { from: tasks, via: "project", fn: "count", where: { column: "status", notIn: ["Done"] } }),
    total("avg_estimate", "Average estimate", { from: tasks, via: "project", fn: "avg", field: "estimate" }),
    total("next_due", "Next due", { from: tasks, via: "project", fn: "min", field: "due" }),
  ]) {
    await admin.post(`/api/schema/${projects}/column`, column).expect(200);
  }

  const add = async (t: string, data: object) => (await admin.post(`/api/table/${t}`, data).expect(200)).body.data.insertedId as string;
  const get = async (t: string, id: string) => (await admin.get(`/api/table/${t}/${id}`)).body;

  const p = await add(projects, { name: "P" });
  const a = await add(tasks, { title: "A", project: p, status: "To do", estimate: 4, due: "2026-12-10" });
  const b = await add(tasks, { title: "B", project: p, status: "Done", estimate: 8, due: "2026-12-01" });
  const l1 = await add(logs, { task: a, hours: 2 });
  const l2 = await add(logs, { task: a, hours: 3 });

  it("works out counts, sums, averages and lowest values, and totals of totals", async () => {
    expect(await get(tasks, a)).toMatchObject({ hours: 5 });
    expect(await get(projects, p)).toMatchObject({ hours: 5, open: 1, avg_estimate: 6, next_due: "2026-12-01" });
    // their kind of result is worked out
    const cols = (await admin.get(`/api/schema/${projects}`)).body.columns;
    expect(cols.find((c: { name: string }) => c.name === "next_due").rollup.type).toBe("date");
  });

  it("follows edits, moves and deletes, up the chain", async () => {
    await admin.put(`/api/table/${logs}/${l2}`, { hours: 4 }).expect(200);
    expect((await get(projects, p)).hours).toBe(6);
    await admin.put(`/api/table/${logs}/${l2}`, { task: b }).expect(200); // moved to B
    expect((await get(tasks, a)).hours).toBe(2);
    expect((await get(tasks, b)).hours).toBe(4);
    expect((await get(projects, p)).hours).toBe(6);
    await admin.del(`/api/table/${logs}/${l1}`).expect(200);
    expect((await get(tasks, a)).hours).toBe(0);
    expect((await get(projects, p)).hours).toBe(4);
    await admin.put(`/api/table/${tasks}/${b}`, { status: "To do" }).expect(200);
    expect((await get(projects, p)).open).toBe(2);
  });

  it("counts imported records", async () => {
    const csv = ["Task,Hours", `${a},1.5`, `${a},2.5`].join("\n");
    const start = await admin.upload(`/api/table/${logs}/import`).attach("file", Buffer.from(csv), "l.csv");
    await drainJobs();
    expect((await admin.get(`/api/jobs/${start.body.job._id}`)).body.result).toMatchObject({ inserted: 2 });
    expect((await get(tasks, a)).hours).toBe(4);
    expect((await get(projects, p)).hours).toBe(8);
  });

  it("explains a total that can't work", async () => {
    const bad = async (rollup: object) =>
      (await admin.post(`/api/schema/${projects}/column`, total(unique("x"), "X", rollup))).body.message as string;
    expect(await bad({ from: tasks, via: "title", fn: "count" })).toMatch(/no link column "title"/);
    expect(await bad({ from: tasks, via: "project", fn: "sum", field: "status" })).toMatch(/only numbers can be added up/);
    expect(await bad({ from: "nope", via: "project", fn: "count" })).toMatch(/doesn't exist/);
    expect(await bad({ from: tasks, via: "project", fn: "sum" })).toMatch(/Choose the field/);
  });

  it("won't delete what a total needs", async () => {
    const col = await admin.del(`/api/schema/${logs}/column/hours`);
    expect(col.status).toBe(400);
    expect(col.body.message).toMatch(/The total "Hours"/);
    expect((await admin.del(`/api/schema/${logs}`)).status).toBe(400);
  });

  it("is worked out for existing records when added, and used by formulas", async () => {
    await admin
      .post(`/api/schema/${projects}/column`, { name: "left", label: "Left", type: "formula", formula: { expression: "{avg_estimate} * {open} - {hours}" } })
      .expect(200);
    expect((await get(projects, p)).left).toBe(6 * 2 - 8);
  });

  it("cleans up", async () => {
    await admin.del(`/api/schema/${projects}/column/left`).expect(200);
    for (const c of ["hours", "open", "avg_estimate", "next_due"]) await admin.del(`/api/schema/${projects}/column/${c}`).expect(200);
    await admin.del(`/api/schema/${tasks}/column/hours`).expect(200);
    await admin.del(`/api/schema/${logs}`).expect(200);
    await admin.del(`/api/schema/${tasks}`).expect(200);
    await admin.del(`/api/schema/${projects}`).expect(200);
  });
});
