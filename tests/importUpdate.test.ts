import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { memoryMailbox } from "../src/mail/mailer.js";
import { login, unique } from "./helpers.js";

// Import: problems that say how to fix them, a "rows to fix" file to import
// again, and updating existing records from an exported file (by ID).
describe("Import: fix problems, and update by ID", async () => {
  const admin = await login();
  const table = unique("orders");
  await admin
    .post("/api/schema", {
      tableName: table,
      byDepartment: false,
      columns: [
        { name: "title", label: "Title", required: true },
        { name: "status", label: "Status", type: "choice", options: [{ label: "Open" }, { label: "Done" }] },
        { name: "due", label: "Due", type: "date" },
        { name: "qty", label: "Qty", type: "number" },
      ],
    })
    .expect(200);
  const run = async (client: typeof admin, csv: string) => {
    const start = await client.upload(`/api/table/${table}/import`).attach("file", Buffer.from(csv), "file.csv");
    expect(start.status, JSON.stringify(start.body)).toBe(202);
    await drainJobs();
    return (await client.get(`/api/jobs/${start.body.job._id}`)).body;
  };
  const rows = async () => (await admin.get(`/api/table/${table}?limit=100&sort=title&order=asc`)).body.data as Record<string, unknown>[];

  it("stops at once when a required column is missing from the file", async () => {
    const job = await run(admin, "Status,Due\nOpen,2026-12-01\n");
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/no "Title" column, which every new record needs/);
    expect(await rows()).toEqual([]);
  });

  it("says what's wrong with each row, and gives the rows back to fix", async () => {
    const csv = ["Title,Status,Due,Qty,Colour", "Good,Open,2026-12-01,2,red", "Bad date,Open,31/12/26,1,", "Bad status,Complete,,1,"].join("\n");
    const job = await run(admin, csv);
    expect(job.result).toMatchObject({ inserted: 1, failed: 2 });
    const messages = job.result.errors.map((e: { message: string }) => e.message);
    expect(messages[0]).toMatch(/aren't in the table and were left out: Colour/);
    expect(messages).toContain('Due must be a date, written like 2026-12-31 (the file has "31/12/26")');
    expect(messages.find((m: string) => m.startsWith('"Complete"'))).toMatch(/choose: Open, Done/);

    // the file to fix: the rows as they were, plus why
    const file = (await admin.get(`/api/jobs/${job._id}/download`)).text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(file[0]).toBe("Title,Status,Due,Qty,Problem");
    expect(file[1]).toMatch(/^Bad date,Open,31\/12\/26,1,"?Due must be a date/);

    // fixed in that file and imported again: the Problem column is skipped
    const fixed = ["Title,Status,Due,Qty,Problem", "Bad date,Open,2026-12-31,1,Due must be a date", "Bad status,Done,,1,not an option"].join("\n");
    expect((await run(admin, fixed)).result).toMatchObject({ inserted: 2, failed: 0 });
  });

  it("tells the importer in the bell when it's done (not by email)", async () => {
    const items = (await admin.get("/api/notifications")).body.items as { title: string }[];
    expect(items[0].title).toBe(`Import into ${table.replace(/_/g, " ")} finished: 2 added`);
    expect(memoryMailbox.some((m) => m.subject.startsWith("Import into"))).toBe(false);
  });

  it("updates records from an exported file: rows with an ID change that record", async () => {
    const start = await admin.post(`/api/table/${table}/export`);
    await drainJobs();
    const exported = (await admin.get(`/api/jobs/${start.body.job._id}/download`)).text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(exported[0]).toBe("Title,Status,Due,Qty,Created by,ID");
    const goodId = exported.find((l) => l.startsWith("Good,"))!.split(",").at(-1)!;

    // change Good's status; add a new one; an unknown ID
    const csv = ["Title,Status,ID", `Good,Done,${goodId}`, "Brand new,Open,", "Ghost,Open,no-such-id"].join("\n");
    const job = await run(admin, csv);
    expect(job.result).toMatchObject({ updated: 1, inserted: 1, failed: 1 });
    expect(job.result.errors[0].message).toMatch(/there's no record "no-such-id" that you can change/);
    const good = (await rows()).find((r) => r.title === "Good")!;
    expect(good).toMatchObject({ status: "Done", qty: 2, due: "2026-12-01" }); // columns not in the file stay
    // and its history says so
    const history = (await admin.get(`/api/audit?tableName=${table}&recordId=${goodId}&action=update`)).body.data;
    expect(history[0].changes).toMatchObject({ status: { from: "Open", to: "Done" }, _via: "import" });
  });

  it("needs edit permission to update, create permission to add", async () => {
    const role = (await admin.post("/api/roles", { name: unique("Adder"), permissions: { [table]: { view: true, create: true } } })).body.role;
    const username = unique("adder").toLowerCase();
    await admin.post("/api/users", { username, password: "pass-123-pass", roleId: role._id }).expect(201);
    const adder = await login(username, "pass-123-pass");
    const id = (await rows())[0]._id;
    const job = await run(adder, ["Title,ID", `Renamed,${id}`, "Mine,"].join("\n"));
    expect(job.result).toMatchObject({ inserted: 1, updated: 0, failed: 1 });
    expect(job.result.errors[0].message).toMatch(/can't change records in this table/);
  });

  it('"own only" people can only import their own records', async () => {
    const own = unique("claims");
    await admin.post("/api/schema", { tableName: own, byDepartment: false, columns: [{ name: "what", label: "What" }, { name: "who", label: "Claimed by", type: "user" }] }).expect(200);
    const role = (await admin.post("/api/roles", { name: unique("Claimer"), permissions: { [own]: { view: true, create: true, own: true } } })).body.role;
    const username = unique("claimer").toLowerCase();
    await admin.post("/api/users", { username, fullName: "Claire", password: "pass-123-pass", roleId: role._id }).expect(201);
    const claimer = await login(username, "pass-123-pass");
    const start = await claimer.upload(`/api/table/${own}/import`).attach("file", Buffer.from(["What,Claimed by", "Taxi,", "For the boss,Administrator"].join("\n")), "c.csv");
    await drainJobs();
    const job = (await claimer.get(`/api/jobs/${start.body.job._id}`)).body;
    expect(job.result).toMatchObject({ inserted: 1, failed: 1 });
    expect(job.result.errors[0].message).toMatch(/has to be you/);
    expect((await admin.get(`/api/table/${own}`)).body.data[0].who).toBe("Claire"); // filled in as her
  });
});
