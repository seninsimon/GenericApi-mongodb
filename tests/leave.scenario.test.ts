import { describe, expect, it } from "vitest";
import { upgradeInstalledApps } from "../src/apps/installer.js";
import { query } from "../src/db/pool.js";
import { login, unique } from "./helpers.js";

// workspace/LOGIC_REVIEW.md: Hana runs HR, Sam and Kiran are engineers.
describe("Leave: an engineer asks, HR approves", async () => {
  const admin = await login();
  const remove = async () => {
    const apps = (await admin.get("/api/apps")).body.apps as { key: string; installed: unknown }[];
    for (const key of ["expenses", "payroll", "hr", "people"]) {
      if (apps.find((a) => a.key === key)?.installed) await admin.del(`/api/apps/${key}`).expect(200);
    }
    for (const t of ["leave_requests", "attendance", "holidays", "expense_claims", "employees"]) {
      if ((await admin.get(`/api/schema/${t}`)).status === 200) await admin.del(`/api/schema/${t}`);
    }
  };
  await remove();
  await admin.post("/api/apps/install", { apps: ["hr", "expenses"] }).expect(200);
  const member = (await admin.get("/api/roles")).body.find((r: { name: string }) => r.name === "Member")._id;
  const person = async (name: string, appAccess: object, addToDirectory = true) => {
    const username = unique(name).toLowerCase();
    const res = await admin
      .post("/api/users", { username, fullName: name, password: "pass-123-pass", roleId: member, appAccess, addToDirectory })
      .expect(201);
    return { id: res.body.user._id as string, entry: res.body.directory?.id as string | undefined, client: await login(username, "pass-123-pass") };
  };
  const hana = await person("Hana", { hr: "manager", company: "manager" });
  const sam = await person("Sam", { hr: "staff", company: "staff", expenses: "staff" });
  const kiran = await person("Kiran", { hr: "staff" }); // no People directory access
  const leave = (who: typeof sam, body: object) => who.client.post("/api/table/leave_requests", { from: "2026-12-08", to: "2026-12-09", ...body });
  const titles = async (who: typeof sam | typeof admin) =>
    (((await ("client" in who ? who.client : who).get("/api/notifications")).body.items ?? []) as { title: string }[]).map((n) => n.title);

  it("S1/S3: the form knows it's Sam, and fills him in", async () => {
    const own = (await sam.client.get("/api/schema/leave_requests")).body.ownFields;
    expect(own).toEqual([{ column: "employee", value: sam.entry, label: "Sam" }]);
    const id = (await leave(sam, {}).expect(200)).body.data.insertedId;
    expect((await admin.get(`/api/table/leave_requests/${id}`)).body.employee).toBe(sam.entry);
  });

  it("S2/S10: Sam can't file for Kiran, or claim as Hana", async () => {
    const forKiran = await leave(sam, { employee: kiran.entry });
    expect(forKiran.status).toBe(400);
    expect(forKiran.body.errors.employee).toMatch(/has to be you/);
    expect((await sam.client.post("/api/table/expense_claims", { description: "x", amount: 1, claimant: hana.id })).status).toBe(400);
    await sam.client.post("/api/table/expense_claims", { description: "Taxi", amount: 300 }).expect(200); // his own
  });

  it("S4: Kiran (no directory access) asks for his own leave and sees his name", async () => {
    await leave(kiran, {}).expect(200);
    const mine = (await kiran.client.get("/api/table/leave_requests")).body.data;
    expect(mine.map((l: { employee: string }) => l.employee)).toEqual(["Kiran"]);
  });

  it("S5: HR hears about new requests", async () => {
    expect(await titles(hana)).toContain("New leave request to approve");
    expect(await titles(sam)).not.toContain("New leave request to approve");
    // an app nobody manages yet: the admins hear about it
    expect(await titles(hana)).not.toContain("New expense claim to approve");
    expect(await titles(admin)).toContain("New expense claim to approve");
  });

  it("S7: leave HR enters for Sam and approves: Sam is told", async () => {
    const id = (await leave(hana, { employee: sam.entry, type: "Sick" }).expect(200)).body.data.insertedId;
    await hana.client.put(`/api/table/leave_requests/${id}`, { status: "Approved" }).expect(200);
    expect(await titles(sam)).toContain("Your leave request was approved");
  });

  it("S13: someone not in the People directory is told why", async () => {
    const noor = await person("Noor", { hr: "staff", company: "staff" }, false);
    expect((await noor.client.get("/api/schema/leave_requests")).body.ownFields[0]).toMatchObject({ value: null, missing: expect.stringMatching(/People directory/) });
    const res = await leave(noor, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not in the People directory yet/);
  });

  it("S14: Hana can't approve her own leave; another manager or an admin can", async () => {
    const id = (await leave(hana, { employee: hana.entry }).expect(200)).body.data.insertedId;
    const self = await hana.client.put(`/api/table/leave_requests/${id}`, { status: "Approved" });
    expect(self.status).toBe(400);
    expect(self.body.message).toMatch(/can't approve your own leave request/);
    await admin.put(`/api/table/leave_requests/${id}`, { status: "Approved" }).expect(200);
  });

  it("F7: an HR app installed earlier gets the new automations once", async () => {
    // as installed before: version 2, "tell the creator", no "tell HR"
    await query(`DELETE FROM automations WHERE table_name = 'leave_requests' AND name = 'Tell HR about new leave requests'`);
    await query(
      `UPDATE automations SET actions = '[{"do":"notify","who":"$creator","message":"Your leave request was approved"}]'::jsonb
       WHERE table_name = 'leave_requests' AND name = 'Tell the person when their leave is approved'`
    );
    await query(`UPDATE automations SET trigger = '{"when":"changed","column":"type"}'::jsonb WHERE table_name = 'leave_requests' AND name = 'Tell the person when their leave is rejected'`);
    await query(`UPDATE installed_apps SET version = 2 WHERE key = 'hr'`);

    expect(await upgradeInstalledApps()).toEqual(["hr"]);
    expect(await upgradeInstalledApps()).toEqual([]); // once
    const list = (await admin.get("/api/schema/leave_requests/automations")).body as { name: string; trigger: { column?: string }; actions: { who: string }[] }[];
    const by = (name: string) => list.find((a) => a.name === name)!;
    expect(by("Tell HR about new leave requests").actions[0].who).toBe("$managers");
    expect(by("Tell the person when their leave is approved").actions[0].who).toBe("employee.account");
    // one someone changed (another trigger) is left exactly as it was
    expect(by("Tell the person when their leave is rejected")).toMatchObject({ trigger: { when: "changed", column: "type" } });
  });

  it("cleans up", async () => {
    await remove();
  });
});
