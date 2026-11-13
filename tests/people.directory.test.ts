import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { query } from "../src/db/pool.js";
import { invalidateSchemas } from "../src/schema/schemaRepo.js";
import { login, unique } from "./helpers.js";

// "Add person": one form makes the login and the People directory entry; the
// entry's Department comes from the login's department.
describe("People directory and Add person", async () => {
  const admin = await login();
  const remove = async () => {
    const apps = (await admin.get("/api/apps")).body.apps as { key: string; installed: unknown }[];
    for (const key of ["payroll", "hr", "people"]) {
      if (apps.find((a) => a.key === key)?.installed) await admin.del(`/api/apps/${key}`).expect(200);
    }
    if ((await admin.get("/api/schema/employees")).status === 200) await admin.del("/api/schema/employees");
  };
  await remove();
  await admin.post("/api/apps/install", { apps: ["people"] }).expect(200);
  const dept = async (name: string) => (await admin.post("/api/departments", { name: unique(name) })).body.department;
  const sales = await dept("Sales");
  const ops = await dept("Ops");
  const member = (await admin.get("/api/roles")).body.find((r: { name: string }) => r.name === "Member");
  const employee = async (id: string) => (await admin.get(`/api/table/employees/${id}`)).body;

  it('calls it "Department", following the Login account', async () => {
    const team = (await admin.get("/api/schema/employees")).body.columns.find((c: { name: string }) => c.name === "team");
    expect(team).toMatchObject({ label: "Department", type: "department", fromUser: "account" });
  });

  it("adds the person to the directory with their login and department", async () => {
    const username = unique("meera").toLowerCase();
    const res = await admin
      .post("/api/users", {
        username,
        fullName: "Meera Nair",
        email: "meera@example.com",
        password: "pass-123-pass",
        roleId: member._id,
        departmentIds: [sales._id],
        appAccess: { company: "staff" },
        addToDirectory: true,
      })
      .expect(201);
    expect(res.body.directory.table).toBe("employees");
    const entry = await employee(res.body.directory.id);
    expect(entry).toMatchObject({ full_name: "Meera Nair", account: res.body.user._id, team: sales._id, email: "meera@example.com" });
  });

  it("fills Department from a login picked later, and never overwrites one that's set", async () => {
    const username = unique("omar").toLowerCase();
    const omar = (await admin.post("/api/users", { username, password: "pass-123-pass", roleId: member._id, departmentIds: [ops._id] })).body.user;
    const id = (await admin.post("/api/table/employees", { full_name: "Omar" }).expect(200)).body.data.insertedId;
    expect((await employee(id)).team ?? null).toBeNull();
    await admin.put(`/api/table/employees/${id}`, { account: omar._id }).expect(200);
    expect((await employee(id)).team).toBe(ops._id);

    const set = (await admin.post("/api/table/employees", { full_name: "Set", team: sales._id, account: omar._id })).body.data.insertedId;
    expect((await employee(set)).team).toBe(sales._id);
  });

  it('renames an older install\'s "Team" (once, and only the app\'s own label)', async () => {
    const schema = (await admin.get("/api/schema/employees")).body;
    const old = schema.columns.map((c: { name: string; fromUser?: string }) => {
      if (c.name !== "team") return c;
      const { fromUser: _f, ...rest } = c;
      return { ...rest, label: "Team" };
    });
    await query(`UPDATE table_schemas SET columns = $1::jsonb WHERE table_name = 'employees'`, [JSON.stringify(old)]);
    await query(readFileSync(new URL("../migrations/012_people_department.sql", import.meta.url), "utf8"));
    await invalidateSchemas();
    const team = (await admin.get("/api/schema/employees")).body.columns.find((c: { name: string }) => c.name === "team");
    expect(team).toMatchObject({ label: "Department", fromUser: "account" });
  });

  it("cleans up", async () => {
    await remove();
  });
});
