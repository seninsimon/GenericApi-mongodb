import { describe, expect, it } from "vitest";
import { memoryControl, memoryMailbox } from "../src/mail/mailer.js";
import { processOutbox } from "../src/mail/outbox.js";
import { runMorningSummary } from "../src/mail/summary.js";
import { forgetMailSettings } from "../src/mail/settings.js";
import { query } from "../src/db/pool.js";
import { login, unique } from "./helpers.js";

// workspace/EMAIL_PLAN.md (tests use an in-memory mailbox: nothing is sent)
describe("Email", async () => {
  const admin = await login();
  const mailTo = (address: string) => memoryMailbox.filter((m) => m.to === address);

  // settings as an admin saves them in Administration → Email
  await admin
    .put("/api/email", { provider: "gmail", user: "office@example.com", pass: "abcd efgh ijkl mnop", fromName: "Zenin ERP", appUrl: "http://erp.local/" })
    .expect(200);

  // a person with an email address, and a table with a person field
  const member = (await admin.get("/api/roles")).body.find((r: { name: string }) => r.name === "Member")._id;
  const dept = (await admin.post("/api/departments", { name: unique("Ops") })).body.department;
  const table = unique("jobs");
  await admin.post("/api/schema", { tableName: table, byDepartment: false, columns: [{ name: "title", label: "Title" }, { name: "owner", label: "Owner", type: "user" }, { name: "due", label: "Due", type: "date" }] }).expect(200);
  const role = (await admin.post("/api/roles", { name: unique("Work"), permissions: { [table]: { view: true, create: true, edit: true } } })).body.role;
  const person = async (name: string, email: string) => {
    const username = unique(name).toLowerCase();
    const res = await admin.post("/api/users", { username, fullName: name, email, password: "pass-123-pass", roleId: role._id, departmentIds: [dept._id] }).expect(201);
    return { id: res.body.user._id as string, client: await login(username, "pass-123-pass"), email };
  };
  const bina = await person("Bina", `bina.${unique("x")}@example.com`);

  it("keeps the password out of what the browser sees", async () => {
    const res = (await admin.get("/api/email").expect(200)).body;
    expect(res.settings).toMatchObject({ provider: "gmail", host: "smtp.gmail.com", port: 587, user: "office@example.com", fromAddress: "office@example.com", appUrl: "http://erp.local", hasPassword: true });
    expect(JSON.stringify(res)).not.toContain("abcdefgh");
    // saving without a password keeps the saved one
    const kept = (await admin.put("/api/email", { provider: "gmail", user: "office@example.com", fromName: "Office", appUrl: "http://erp.local" }).expect(200)).body;
    expect(kept.settings).toMatchObject({ fromName: "Office", hasPassword: true });
    expect((await admin.put("/api/email", { provider: "smtp", user: "x", pass: "y", fromAddress: "bad" })).status).toBe(400);
    expect((await bina.client.get("/api/email")).status).toBe(403);
  });

  it("emails what lands in someone's bell, with the record and a link", async () => {
    const id = (await admin.post(`/api/table/${table}`, { title: "Fix the printer", owner: bina.id, due: "2026-12-08" }).expect(200)).body.data.insertedId;
    await processOutbox();
    const [mail] = mailTo(bina.email);
    expect(mail.subject).toBe("Administrator put you as Owner");
    expect(mail.text).toContain("Title: Fix the printer");
    expect(mail.text).toContain("Due: 8 Dec 2026");
    expect(mail.text).toContain(`http://erp.local/table/${table}/${id}`);
    expect(mail.html).toContain("Open in Zenin ERP");
  });

  it("follows each person's choice: never, or once a day", async () => {
    const cara = await person("Cara", `cara.${unique("x")}@example.com`);
    await cara.client.put("/api/auth/profile", { emailPref: "never" }).expect(200);
    await admin.post(`/api/table/${table}`, { title: "Never mind", owner: cara.id }).expect(200);
    await cara.client.put("/api/auth/profile", { emailPref: "daily" }).expect(200);
    await admin.post(`/api/table/${table}`, { title: "Later", owner: cara.id }).expect(200);
    await processOutbox();
    expect(mailTo(cara.email)).toEqual([]);
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND digest_pending`, [cara.id]);
    expect(rows[0].n).toBe(1); // "Later" waits for the morning summary; "Never mind" doesn't
    expect((await cara.client.put("/api/auth/profile", { emailPref: "sometimes" })).status).toBe(400);
  });

  it("tries again when sending fails, then gives up and shows why", async () => {
    memoryControl.failNext = 1;
    await admin.post(`/api/table/${table}`, { title: "Retry me", owner: bina.id }).expect(200);
    const before = mailTo(bina.email).length;
    await processOutbox();
    const { rows } = await query<{ _id: string; status: string; attempts: number; last_error: string }>(
      `SELECT _id, status, attempts, last_error FROM email_outbox WHERE subject LIKE '%Owner' ORDER BY _id DESC LIMIT 1`
    );
    expect(rows[0]).toMatchObject({ status: "queued", attempts: 1, last_error: expect.stringMatching(/didn't answer/) });
    await query(`UPDATE email_outbox SET next_attempt_at = now() WHERE _id = $1`, [rows[0]._id]);
    await processOutbox();
    expect(mailTo(bina.email).length).toBe(before + 1);
    const recent = (await admin.get("/api/email")).body.recent;
    expect(recent.find((r: { _id: string }) => r._id === rows[0]._id)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("sends the admin a test email", async () => {
    expect((await admin.post("/api/email/test")).status).toBe(400); // no address yet
    await admin.put("/api/auth/profile", { email: "admin@example.com" }).expect(200);
    await admin.post("/api/email/test").expect(200);
    expect(mailTo("admin@example.com").at(-1)?.subject).toBe("Test email from Zenin ERP");
  });

  it("sends the morning summary once a day: tasks due, and the day's updates", async () => {
    await admin.put("/api/email", { provider: "gmail", user: "office@example.com", fromName: "Office", appUrl: "http://erp.local", timeZone: "Asia/Kolkata", summaryHour: 8 }).expect(200);
    forgetMailSettings();
    const apps = (await admin.get("/api/apps")).body.apps as { key: string; installed: unknown }[];
    if (!apps.find((a) => a.key === "projects")?.installed) await admin.post("/api/apps/install", { apps: ["projects"] }).expect(200);
    // 7 Dec, 09:00 in Kolkata; a task due tomorrow, one long done, one next week
    const now = new Date("2026-12-07T03:30:00Z");
    await admin.post("/api/table/tasks", { title: "Ship the release", assignee: bina.id, due: "2026-12-08" }).expect(200);
    await admin.post("/api/table/tasks", { title: "Old and done", assignee: bina.id, due: "2026-12-01", status: "Done" }).expect(200);
    await admin.post("/api/table/tasks", { title: "Next week", assignee: bina.id, due: "2026-12-14" }).expect(200);
    await processOutbox();
    memoryMailbox.length = 0;

    expect(await runMorningSummary(new Date("2026-12-07T01:00:00Z"))).toBe(0); // 06:30 there: too early
    expect(await runMorningSummary(now)).toBeGreaterThan(0);
    await processOutbox();
    const summary = mailTo(bina.email).find((m) => m.subject.startsWith("Your day"))!;
    expect(summary.subject).toBe("Your day, Monday 7 December: 1 thing");
    expect(summary.text).toContain("Your tasks due by tomorrow, or overdue");
    expect(summary.text).toContain("Ship the release (8 Dec)");
    expect(summary.text).not.toContain("Next week");
    expect(summary.text).not.toContain("Old and done");
    // the "once a day" person gets their updates in it
    expect(memoryMailbox.some((m) => m.subject.startsWith("Your day") && m.text.includes("Updates since yesterday") && m.text.includes("put you as Owner"))).toBe(true);
    // once a day
    expect(await runMorningSummary(new Date("2026-12-07T10:00:00Z"))).toBe(0);
    await admin.del("/api/apps/projects").expect(200);
  });
});
