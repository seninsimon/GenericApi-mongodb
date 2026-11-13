import { describe, expect, it } from "vitest";
import { ensureAppRoles } from "../src/apps/installer.js";
import { mergePermissions } from "../src/auth/mergePermissions.js";
import { query } from "../src/db/pool.js";
import { login, unique } from "./helpers.js";

describe("Rights from several roles", () => {
  const t = (p: object) => ({ view: false, create: false, edit: false, delete: false, ...p });

  it("adds rights up, table by table", () => {
    const merged = mergePermissions([{ a: t({ view: true }) }, { a: t({ view: true, edit: true }), b: t({ view: true }) }]);
    expect(merged.a).toMatchObject({ view: true, edit: true, create: false });
    expect(merged.a.own).toBeUndefined();
    expect(merged.b).toMatchObject({ view: true });
  });

  it("seeing everyone wins over editing only your own entry", () => {
    // the directory for everyone, plus "your own profile" from another role
    const merged = mergePermissions([{ people: t({ view: true }) }, { people: t({ view: true, edit: true, own: true }) }]);
    expect(merged.people).toMatchObject({ view: true, edit: false });
    expect(merged.people.own).toBeUndefined();
  });

  it("stays own-only when every role says so", () => {
    const merged = mergePermissions([{ leave: t({ view: true, own: true }) }, { leave: t({ view: true, create: true, own: true }) }]);
    expect(merged.leave).toMatchObject({ view: true, create: true, own: true });
  });
});

// Expense claims has an approval step (Approved, Rejected, Reimbursed: managers only).
describe("App access on a person", async () => {
  const admin = await login();
  const remove = async () => {
    if ((await admin.get("/api/apps")).body.apps.find((a: { key: string }) => a.key === "expenses")?.installed) {
      await admin.del("/api/apps/expenses").expect(200);
    }
    if ((await admin.get("/api/schema/expense_claims")).status === 200) await admin.del("/api/schema/expense_claims");
  };
  await remove();
  await admin.post("/api/apps/install", { apps: ["expenses"] }).expect(200);
  const member = (await admin.get("/api/roles")).body.find((r: { name: string }) => r.name === "Member");
  const username = unique("ravi").toLowerCase();
  const ravi = (
    await admin.post("/api/users", { username, password: "pass-123-pass", roleId: member._id, appAccess: { expenses: "staff" } }).expect(201)
  ).body.user;
  const client = await login(username, "pass-123-pass");
  const claim = (body: object) => client.post("/api/table/expense_claims", { description: "Taxi", amount: 300, ...body });

  it("lists the apps a person can be given, with their levels", async () => {
    const options = (await admin.get("/api/users/app-access").expect(200)).body;
    expect(options.find((o: { key: string }) => o.key === "expenses")).toMatchObject({
      name: "Expense claims",
      levels: [expect.objectContaining({ level: "staff", label: "Staff" }), expect.objectContaining({ level: "manager", label: "Manager" })],
    });
  });

  it("staff can claim but not approve; managers can approve", async () => {
    expect(ravi.appAccess).toEqual({ expenses: "staff" });
    await claim({}).expect(200);
    expect((await claim({ status: "Approved" })).status).toBe(400);

    const updated = (await admin.put(`/api/users/${ravi._id}`, { appAccess: { expenses: "manager" } }).expect(200)).body.user;
    expect(updated.appAccess).toEqual({ expenses: "manager" });
    // someone else's claim, yes; his own, no
    const adminId = (await admin.get("/api/auth/me")).body.user._id;
    await claim({ claimant: adminId, status: "Approved" }).expect(200);
    const own = await claim({ status: "Approved" });
    expect(own.status).toBe(400);
    expect(own.body.message).toMatch(/can't approve your own/);
  });

  it("no access takes the app away; a level the app doesn't have is refused", async () => {
    await admin.put(`/api/users/${ravi._id}`, { appAccess: { expenses: null } }).expect(200);
    expect((await client.get("/api/table/expense_claims")).status).toBe(404);
    expect((await admin.put(`/api/users/${ravi._id}`, { appAccess: { expenses: "boss" } })).status).toBe(400);
    await admin.put(`/api/users/${ravi._id}`, { appAccess: { expenses: "staff" } }).expect(200);
  });

  it("gives apps installed before app roles existed their roles, once", async () => {
    // as an older install: no app roles, approvals tied to some other role
    await query(`DELETE FROM roles WHERE app_key = 'expenses'`);
    expect(await ensureAppRoles()).toBe(1);
    expect(await ensureAppRoles()).toBe(0);
    const roles = (await admin.get("/api/roles")).body.filter((r: { appKey: string }) => r.appKey === "expenses");
    expect(roles.map((r: { appLevel: string }) => r.appLevel).sort()).toEqual(["manager", "staff"]);
    const manager = roles.find((r: { appLevel: string }) => r.appLevel === "manager");
    const status = (await admin.get("/api/schema/expense_claims")).body.columns.find((c: { name: string }) => c.name === "status");
    expect(status.options.find((o: { label: string }) => o.label === "Approved").roles).toContain(manager._id);
  });

  it("removing the app removes its roles", async () => {
    await remove();
    expect((await admin.get("/api/roles")).body.some((r: { appKey: string }) => r.appKey === "expenses")).toBe(false);
    expect((await admin.get("/api/users")).body.find((u: { _id: string }) => u._id === ravi._id).appAccess).toEqual({});
  });
});
