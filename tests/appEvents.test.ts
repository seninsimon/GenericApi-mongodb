import { describe, expect, it } from "vitest";
import { memoryMailbox } from "../src/mail/mailer.js";
import { processOutbox } from "../src/mail/outbox.js";
import { login, unique } from "./helpers.js";

// workspace/EMAIL_PLAN.md §1: the events apps now tell people about (bell + email)
describe("App events that reach people", async () => {
  const admin = await login();
  const remove = async () => {
    const apps = (await admin.get("/api/apps")).body.apps as { key: string; installed: unknown }[];
    for (const key of ["helpdesk", "payroll", "hr", "customers", "people"]) {
      if (apps.find((a) => a.key === key)?.installed) await admin.del(`/api/apps/${key}`).expect(200);
    }
  };
  await remove();
  await admin.put("/api/email", { provider: "gmail", user: "office@example.com", pass: "x".repeat(16), appUrl: "http://erp.local" }).expect(200);
  await admin.post("/api/apps/install", { apps: ["payroll", "helpdesk"] }).expect(200);
  const member = (await admin.get("/api/roles")).body.find((r: { name: string }) => r.name === "Member")._id;
  const person = async (name: string, appAccess: object) => {
    const username = unique(name).toLowerCase();
    const email = `${username}@example.com`;
    const res = await admin
      .post("/api/users", { username, fullName: name, email, password: "pass-123-pass", roleId: member, appAccess, addToDirectory: true })
      .expect(201);
    return { id: res.body.user._id as string, entry: res.body.directory?.id as string, email, client: await login(username, "pass-123-pass") };
  };
  const bell = async (who: { client: Awaited<ReturnType<typeof login>> }) =>
    ((await who.client.get("/api/notifications")).body.items as { title: string }[]).map((n) => n.title);

  const pay = await person("Priya", { payroll: "manager", company: "staff" });
  const emp = await person("Arun", { payroll: "staff", company: "staff", helpdesk: "staff" });
  const desk = await person("Dina", { helpdesk: "manager", company: "staff" });

  it("payroll: the employee hears when their payslip is ready and paid", async () => {
    const id = (await pay.client.post("/api/table/payslips", { employee: emp.entry, month: "2026-11-01", basic: 50000 }).expect(200)).body.data.insertedId;
    await pay.client.put(`/api/table/payslips/${id}`, { status: "Approved" }).expect(200);
    await pay.client.put(`/api/table/payslips/${id}`, { status: "Paid" }).expect(200);
    expect(await bell(emp)).toEqual(expect.arrayContaining(["Your payslip is ready", "Your salary was paid"]));
    await processOutbox();
    expect(memoryMailbox.filter((m) => m.to === emp.email).map((m) => m.subject)).toEqual(expect.arrayContaining(["Your payslip is ready", "Your salary was paid"]));
  });

  it("a record created already paid keeps the date typed in", async () => {
    const id = (
      await pay.client.post("/api/table/payslips", { employee: emp.entry, month: "2026-10-01", basic: 50000, status: "Paid", paid_on: "2026-10-31" }).expect(200)
    ).body.data.insertedId;
    expect((await admin.get(`/api/table/payslips/${id}`)).body.paid_on).toBe("2026-10-31");
  });

  it("helpdesk: managers hear about urgent tickets, also ones created as urgent", async () => {
    await emp.client.post("/api/table/tickets", { subject: "Server down", priority: "Urgent" }).expect(200);
    expect(await bell(desk)).toContain("Urgent ticket");
  });

  it("cleans up", async () => {
    await remove();
  });
});
