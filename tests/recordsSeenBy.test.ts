import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// "Who sees the records": each department only its own (byDepartment, the
// default for tables made through the API), or everyone who can use the table.
describe('"Who sees the records", per table', async () => {
  const admin = await login();
  const dept = async (name: string) => (await admin.post("/api/departments", { name: unique(name) })).body.department;
  const front = await dept("Front desk");
  const doctors = await dept("Doctors");

  const patients = unique("patients");
  await admin.post("/api/schema", { tableName: patients, columns: [{ name: "name", label: "Name" }, { name: "owner", label: "Owner", type: "user" }] }).expect(200);
  await admin.put(`/api/schema/${patients}`, { departmentIds: [front._id, doctors._id] }).expect(200);

  const role = async (perms: object) => (await admin.post("/api/roles", { name: unique("Role"), permissions: { [patients]: perms } })).body.role;
  const person = async (name: string, roleId: string, departmentIds: string[]) => {
    const username = unique(name).toLowerCase();
    await admin.post("/api/users", { username, password: "pass-123-pass", roleId, departmentIds }).expect(201);
    return login(username, "pass-123-pass");
  };
  const work = await role({ view: true, create: true, edit: true });
  const rita = await person("rita", work._id, [front._id]); // front desk
  const dan = await person("dan", work._id, [doctors._id]); // a doctor
  const nobody = await person("nina", work._id, []); // no department yet
  const names = async (who: typeof rita) => (await who.get(`/api/table/${patients}?limit=50`)).body.data?.map((r: { name: string }) => r.name).sort();

  it("by default each department sees only its own records", async () => {
    expect((await admin.get(`/api/schema/${patients}`)).body.byDepartment).toBe(true);
    await rita.post(`/api/table/${patients}`, { name: "Anu" }).expect(200);
    expect(await names(rita)).toEqual(["Anu"]);
    expect(await names(dan)).toEqual([]);
    expect((await nobody.get(`/api/table/${patients}`)).status).toBe(404); // no department: no table
  });

  it("everyone who can use the table sees all its records once it's shared", async () => {
    await admin.put(`/api/schema/${patients}`, { byDepartment: false }).expect(200);
    expect(await names(dan)).toEqual(["Anu"]);
    expect(await names(nobody)).toEqual(["Anu"]);

    // no department to choose, and none needed
    await nobody.post(`/api/table/${patients}`, { name: "Joel" }).expect(200);
    await dan.post(`/api/table/${patients}`, { name: "Meera" }).expect(200);
    expect(await names(rita)).toEqual(["Anu", "Joel", "Meera"]);
    // no "Visible to" column: it means nothing here
    expect((await dan.get(`/api/table/${patients}`)).body.data[0]).not.toHaveProperty("_department");
    // the creator's department is still noted
    const meera = (await dan.get(`/api/table/${patients}?search=Meera`)).body.data[0];
    expect((await admin.get(`/api/table/${patients}/${meera._id}`)).body._departmentId).toBe(doctors._id);

    const audit = (await admin.get(`/api/audit?tableName=${patients}&action=settings&limit=1`)).body.data[0];
    expect(audit.changes.recordsSeenBy).toBe("everyone with access");
  });

  it('"Own only" still applies on shared tables', async () => {
    const own = await role({ view: true, create: true, own: true });
    const olga = await person("olga", own._id, []);
    await olga.post(`/api/table/${patients}`, { name: "Olga's" }).expect(200);
    expect(await names(olga)).toEqual(["Olga's"]);
  });

  it("switching back hides other departments' records again", async () => {
    await admin.put(`/api/schema/${patients}`, { byDepartment: true }).expect(200);
    expect(await names(dan)).toEqual(["Meera"]);
    expect((await nobody.get(`/api/table/${patients}`)).status).toBe(404);
  });
});
