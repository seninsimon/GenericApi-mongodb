import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, unique } from "./helpers.js";

type Option = { id: string; label: string; color: string };

// "Choice" columns: a fixed list of options (Status, Priority, Tags).
describe("Choice columns", async () => {
  const admin = await login();
  const t = unique("choices");
  const created = await admin
    .post("/api/schema", {
      tableName: t,
      columns: [
        { name: "title", label: "Title", required: true },
        { name: "status", label: "Status", type: "choice", options: ["To do", "Doing", { label: "Done", color: "green" }] },
        { name: "tags", label: "Tags", type: "choice", multiple: true, options: ["Red", "Blue", "Green"] },
        { name: "note", label: "Note" },
      ],
    })
    .expect(200);
  const columns = created.body.columns ?? (await admin.get(`/api/schema/${t}`)).body.columns;
  const statusOptions: Option[] = columns.find((c: { name: string }) => c.name === "status").options;

  const add = async (data: object) => (await admin.post(`/api/table/${t}`, data).expect(200)).body.data.insertedId as string;
  // the record's fields come back at the top level
  const get = async (id: string) => ({ data: (await admin.get(`/api/table/${t}/${id}`)).body });
  const titles = async (query: string) =>
    (await admin.get(`/api/table/${t}?limit=100&${query}`)).body.data.map((r: { title: string }) => r.title);
  const filter = (f: object[]) => `filters=${encodeURIComponent(JSON.stringify(f))}`;

  const a = await add({ title: "A", status: "doing ", tags: ["red", "Blue", "red"] });
  const b = await add({ title: "B", status: "Done" });
  const c = await add({ title: "C", status: "To do", tags: ["Green"] });
  const d = await add({ title: "D" });

  it("gives every option an id and a colour", () => {
    expect(statusOptions.map((o) => o.label)).toEqual(["To do", "Doing", "Done"]);
    expect(statusOptions.every((o) => o.id && o.color)).toBe(true);
    expect(statusOptions[2].color).toBe("green");
    expect(new Set(statusOptions.map((o) => o.color)).size).toBe(3);
  });

  it("refuses choice columns without options, or with duplicates", async () => {
    const res = await admin.post(`/api/schema/${t}/column`, { name: "empty", label: "Empty", type: "choice", options: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one option/);
    const dup = await admin.post(`/api/schema/${t}/column`, { name: "dup", type: "choice", options: ["Yes", "yes"] });
    expect(dup.status).toBe(400);
    expect(dup.body.message).toMatch(/listed twice/);
  });

  it("stores the option's exact label, ignoring case and spaces", async () => {
    expect((await get(a)).data).toMatchObject({ status: "Doing", tags: ["Red", "Blue"] });
  });

  it("refuses values that aren't options", async () => {
    const res = await admin.post(`/api/table/${t}`, { title: "X", status: "Urgent" });
    expect(res.status).toBe(400);
    expect(res.body.errors.status).toMatch(/"Urgent" is not an option for Status \(choose: To do, Doing, Done\)/);
    expect((await admin.post(`/api/table/${t}`, { title: "X", tags: ["Red", "Pink"] })).status).toBe(400);
  });

  it("sorts by the options' order", async () => {
    expect(await titles("sort=status&order=asc")).toEqual(["C", "A", "B", "D"]);
    expect((await titles("sort=status&order=desc")).slice(1)).toEqual(["B", "A", "C"]);
  });

  it("filters with is any of / is none of / is empty", async () => {
    expect((await titles(filter([{ field: "status", op: "in", value: ["Doing", "Done"] }]))).sort()).toEqual(["A", "B"]);
    // "is none of" includes records with no value
    expect((await titles(filter([{ field: "status", op: "notIn", value: ["Done"] }]))).sort()).toEqual(["A", "C", "D"]);
    expect((await titles(filter([{ field: "tags", op: "in", value: ["Green"] }])))).toEqual(["C"]);
    expect((await titles(filter([{ field: "tags", op: "notIn", value: ["Red"] }]))).sort()).toEqual(["B", "C", "D"]);
    expect((await titles(filter([{ field: "status", op: "isEmpty" }])))).toEqual(["D"]);
  });

  it("renaming an option updates existing records (swaps too)", async () => {
    const [todo, doing, done] = statusOptions;
    const res = await admin
      .put(`/api/schema/${t}/column/status`, {
        options: [todo, { ...doing, label: "Done" }, { ...done, label: "Doing" }], // swap names
      })
      .expect(200);
    expect(res.body.rewritten).toBe(2);
    expect((await get(a)).data.status).toBe("Done");
    expect((await get(b)).data.status).toBe("Doing");

    const tagCol = (await admin.get(`/api/schema/${t}`)).body.columns.find((c: { name: string }) => c.name === "tags");
    const renamed = tagCol.options.map((o: Option) => (o.label === "Red" ? { ...o, label: "Crimson" } : o));
    expect((await admin.put(`/api/schema/${t}/column/tags`, { options: renamed }).expect(200)).body.rewritten).toBe(1);
    expect((await get(a)).data.tags).toEqual(["Crimson", "Blue"]);

    // the rename is in the column's history
    const audit = await admin.get(`/api/audit?tableName=${t}&entity=column`);
    expect(JSON.stringify(audit.body.data[0].changes)).toMatch(/Crimson/);
  });

  it("keeps removed options on old records until that field changes", async () => {
    const options = (await admin.get(`/api/schema/${t}`)).body.columns.find((c: { name: string }) => c.name === "status").options;
    await admin.put(`/api/schema/${t}/column/status`, { options: options.filter((o: Option) => o.label !== "Doing") }).expect(200);
    expect((await get(b)).data.status).toBe("Doing"); // still there
    await admin.put(`/api/table/${t}/${b}`, { note: "edited" }).expect(200); // other fields can change
    await admin.put(`/api/table/${t}/${b}`, { status: "Doing" }).expect(200); // unchanged value is fine
    expect((await admin.put(`/api/table/${t}/${c}`, { status: "Doing" })).status).toBe(400); // can't pick it anew
  });

  it("turns a Text column into a Choice using its values, and back", async () => {
    await admin.post(`/api/schema/${t}/column`, { name: "priority", label: "Priority", indexed: true }).expect(200);
    await admin.put(`/api/table/${t}/${a}`, { priority: "high" });
    await admin.put(`/api/table/${t}/${b}`, { priority: "High " });
    await admin.put(`/api/table/${t}/${c}`, { priority: "low" });

    const res = await admin.put(`/api/schema/${t}/column/priority`, { type: "choice" }).expect(200);
    expect(res.body.data.options.map((o: Option) => o.label.toLowerCase())).toEqual(["high", "low"]);
    expect(res.body.data.indexed).toBe(false);
    const high = res.body.data.options[0].label;
    expect([(await get(a)).data.priority, (await get(b)).data.priority]).toEqual([high, high]);

    // several picks become "A, B" text
    await admin.put(`/api/schema/${t}/column/tags`, { type: "text" }).expect(200);
    expect((await get(a)).data.tags).toBe("Crimson, Blue");

    // only Text <-> Choice
    expect((await admin.put(`/api/schema/${t}/column/status`, { type: "number" })).status).toBe(400);
  });

  it("refuses converting a column with too many different values", async () => {
    const many = unique("many");
    await admin.post("/api/schema", { tableName: many, columns: [{ name: "code", label: "Code" }] }).expect(200);
    for (let i = 0; i < 51; i++) await admin.post(`/api/table/${many}`, { code: `c${i}` });
    const res = await admin.put(`/api/schema/${many}/column/code`, { type: "choice" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/more than 50 different values/);
    await admin.del(`/api/schema/${many}`);
  });

  it("exports labels and imports them ignoring case, reporting unknown ones", async () => {
    const csvT = unique("choice_csv");
    await admin.post("/api/schema", {
      tableName: csvT,
      columns: [
        { name: "title", label: "Title" },
        { name: "stage", label: "Stage", type: "choice", options: ["Lead", "Won"] },
        { name: "labels", label: "Labels", type: "choice", multiple: true, options: ["X", "Y"] },
      ],
    });
    const csv = ["Title,Stage,Labels", "one,lead,x;Y", "two,Lost,", "three,,y"].join("\n");
    const start = await admin.upload(`/api/table/${csvT}/import`).attach("file", Buffer.from(csv), "c.csv");
    await drainJobs();
    const job = (await admin.get(`/api/jobs/${start.body.job._id}`)).body;
    expect(job.result).toMatchObject({ inserted: 2, failed: 1 });
    expect(job.result.errors[0].message).toMatch(/"Lost" is not an option for Stage/);

    const exp = await admin.post(`/api/table/${csvT}/export`);
    await drainJobs();
    const lines = (await admin.get(`/api/jobs/${exp.body.job._id}/download`)).text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines).toContain("one,Lead,X;Y,Administrator");
    await admin.del(`/api/schema/${csvT}`);
  });

  it("cleans up", async () => {
    for (const id of [a, b, c, d]) await admin.del(`/api/table/${t}/${id}`);
    await admin.del(`/api/schema/${t}`).expect(200);
  });
});
