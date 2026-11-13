import { describe, expect, it } from "vitest";
import { APPS, BUNDLES, fullKey } from "../src/apps/index.js";
import { normalizeColumn } from "../src/schema/columns.js";
import { checkFormulas } from "../src/schema/formula.js";
import { checkRollups } from "../src/schema/rollups.js";
import { normalizeAutomation } from "../src/schema/automations.js";
import type { Column } from "../src/types.js";
import { login, unique } from "./helpers.js";

// The catalog itself: keys unique, links point somewhere valid, totals and formulas work.
describe("App catalog", () => {
  it("has unique keys and valid links, needs, totals and formulas", async () => {
    // every table's columns, named by full key ("projects.tasks"), links and totals too
    const columnsByKey = new Map<string, Column[]>();
    for (const app of APPS) {
      for (const table of app.tables) {
        columnsByKey.set(
          fullKey(app, table.key),
          table.columns.map((c) => {
            const rollup = c.rollup as { from: string } | undefined;
            return normalizeColumn({
              ...c,
              ...(c.type === "relation" ? { ref: fullKey(app, c.ref!) } : {}),
              ...(rollup ? { rollup: { ...rollup, from: fullKey(app, rollup.from) } } : {}),
            } as Record<string, unknown> & { name: string });
          })
        );
      }
    }
    // columns apps add to other apps' tables join those tables
    for (const app of APPS) {
      for (const [target, extra] of Object.entries(app.extend ?? {})) {
        expect((app.needs ?? []).includes(target.split(".")[0]), `${app.key} extends ${target}`).toBe(true);
        columnsByKey.set(target, [
          ...columnsByKey.get(target)!,
          ...extra.map((c) => {
            const rollup = c.rollup as { from: string } | undefined;
            return normalizeColumn({
              ...c,
              ...(rollup ? { rollup: { ...rollup, from: fullKey(app, rollup.from) } } : {}),
            } as Record<string, unknown> & { name: string });
          }),
        ]);
      }
    }
    for (const [key, columns] of columnsByKey) {
      await expect(checkRollups(key, columns, async (name) => columnsByKey.get(name) ?? null), key).resolves.toBeUndefined();
    }
    const keys = new Set<string>();
    for (const app of APPS) {
      expect(keys.has(app.key), app.key).toBe(false);
      keys.add(app.key);
      const tableKeys = new Set(app.tables.map((t) => t.key));
      expect(tableKeys.size).toBe(app.tables.length);
      for (const table of app.tables) {
        for (const column of table.columns.filter((c) => c.type === "relation")) {
          const target = fullKey(app, column.ref!);
          const [targetApp, targetTable] = target.split(".");
          // same app, or an app listed in `needs`
          expect(targetApp === app.key || (app.needs ?? []).includes(targetApp), `${app.key}.${table.key}.${column.name}`).toBe(true);
          expect(APPS.find((a) => a.key === targetApp)?.tables.some((t) => t.key === targetTable), target).toBe(true);
        }
        // formulas type-check (with the totals' types worked out above)
        expect(() => checkFormulas(columnsByKey.get(fullKey(app, table.key))!), `${app.key}.${table.key}`).not.toThrow();
      }
      for (const need of app.needs ?? []) expect(APPS.some((a) => a.key === need), need).toBe(true);
    }
    // dashboards count real tables, with real columns and options
    for (const app of APPS) {
      const d = app.dashboard;
      if (!d) continue;
      for (const tile of d.tiles) {
        const columns = columnsByKey.get(fullKey(app, tile.table));
        expect(columns, `${app.key}: ${tile.label}`).toBeTruthy();
        for (const f of tile.filters ?? []) {
          const column = columns!.find((c) => c.name === f.field);
          expect(column, `${app.key}: ${tile.label} / ${f.field}`).toBeTruthy();
          if (column!.type === "choice" && Array.isArray(f.value)) {
            for (const v of f.value) expect(column!.options!.some((o) => o.label === v), `${app.key}: ${tile.label} / ${v}`).toBe(true);
          }
        }
      }
      if (d.breakdown) {
        const column = columnsByKey.get(fullKey(app, d.breakdown.table))?.find((c) => c.name === d.breakdown!.column);
        expect(column?.type, `${app.key}: ${d.breakdown.label}`).toBe("choice");
      }
    }
    // automations name real columns of the app's tables
    for (const app of APPS) {
      for (const a of app.automations ?? []) {
        const columns = columnsByKey.get(fullKey(app, a.table))!;
        // links in the catalog name tables by key ("people.employees")
        const schemaOf = (ref: string) => ({ tableName: ref, columns: columnsByKey.get(ref.includes(".") ? ref : fullKey(app, ref)) ?? [] });
        await expect(normalizeAutomation({ tableName: a.table, columns } as never, a, schemaOf as never), `${app.key}: ${a.name}`).resolves.toBeTruthy();
      }
    }
    for (const bundle of BUNDLES) for (const key of bundle.apps) expect(keys.has(key), `${bundle.key}: ${key}`).toBe(true);
    // a bundle key that's also an app key would install the whole bundle
    for (const bundle of BUNDLES) expect(keys.has(bundle.key), `bundle ${bundle.key} clashes with an app`).toBe(false);
  });
});

// Installing apps: a shared test database, so start from no apps installed.
describe("Installing apps", async () => {
  const admin = await login();

  const reset = async () => {
    // a table of yours that an app used keeps its links: delete it first
    if ((await admin.get("/api/schema/deals")).body.blueprintKey === null) await admin.del("/api/schema/deals");
    const installed = (await admin.get("/api/apps")).body.apps.filter((a: { installed: unknown }) => a.installed);
    // apps that others need go last
    for (const key of ["clinic", "school", "ngo", "billing", "inventory", "payroll", "expenses", "assets", "helpdesk", "crm", "hr", "projects", "customers", "products", "people"]) {
      if (installed.some((a: { key: string }) => a.key === key)) await admin.del(`/api/apps/${key}`).expect(200);
    }
    for (const name of ["deals", "deals_2", "activities", "projects", "tasks", "time_logs", "companies", "contacts", "employees", "leave_requests", "attendance", "holidays", "tickets", "products", "invoices", "invoice_lines", "payments", "quotes", "quote_lines", "suppliers", "purchase_orders", "po_lines", "stock_moves", "payslips", "expense_claims", "assets", "maintenance", "patients", "appointments", "consultations", "prescription_items", "bills", "bill_lines", "classes", "students", "subjects", "student_attendance", "exams", "marks", "fees", "programmes", "donors", "donations", "volunteers", "volunteer_hours"]) {
      if ((await admin.get(`/api/schema/${name}`)).status === 200) await admin.del(`/api/schema/${name}`);
    }
  };
  await reset();

  const dept = (await admin.post("/api/departments", { name: unique("Team") })).body.department;
  const schema = async (name: string) => (await admin.get(`/api/schema/${name}`)).body;
  const records = async (name: string) => (await admin.get(`/api/table/${name}?limit=100`)).body.data as Record<string, unknown>[];

  it("lists apps and organization types", async () => {
    const { apps, bundles } = (await admin.get("/api/apps")).body;
    expect(apps.map((a: { key: string }) => a.key)).toEqual(expect.arrayContaining(["projects", "hr", "crm", "helpdesk", "people"]));
    expect(bundles.find((b: { key: string }) => b.key === "it").apps).toContain("projects");
  });

  it("previews an install, pulling in what an app needs", async () => {
    const plan = (await admin.post("/api/apps/plan", { apps: ["hr"] }).expect(200)).body;
    expect(plan.apps).toEqual([
      expect.objectContaining({ key: "people", status: "install", pulledIn: true }),
      expect.objectContaining({ key: "hr", status: "install", pulledIn: false }),
    ]);
    const leave = plan.tables.find((t: { key: string }) => t.key === "hr.leave_requests");
    expect(leave).toMatchObject({ action: "create", tableName: "leave_requests" });
    expect(leave.links).toEqual([expect.objectContaining({ to: "people.employees", toLabel: "Employees" })]);
    // each app brings its own roles
    expect(plan.roles.map((r: { name: string }) => r.name).sort()).toEqual([
      "HR & leave · Manager",
      "HR & leave · Staff",
      "People directory · Manager",
      "People directory · Staff",
    ]);
    expect(plan.roles.find((r: { name: string }) => r.name === "HR & leave · Staff").level).toBe("staff");
  });

  it("leaves out optional tables and the links to them", async () => {
    const plan = (await admin.post("/api/apps/plan", { apps: ["projects"], options: { tables: { "projects.projects": false } } })).body;
    expect(plan.tables.find((t: { key: string }) => t.key === "projects.projects").action).toBe("skip");
    expect(plan.tables.find((t: { key: string }) => t.key === "projects.tasks").dropped).toEqual(["Project"]);
  });

  it("installs an app with linked tables, roles and sample records", async () => {
    const result = (
      await admin.post("/api/apps/install", { apps: ["projects"], options: { departmentIds: [dept._id], sampleData: true } }).expect(200)
    ).body;
    expect(result.apps).toEqual(["projects"]);
    expect(result.sampleRecords).toBeGreaterThan(5);

    const tasks = await schema("tasks");
    expect(tasks).toMatchObject({ blueprintKey: "projects.tasks", appKey: "projects" });
    expect(tasks.departments.map((d: { _id: string }) => d._id)).toEqual([dept._id]);
    expect(tasks.columns.find((c: { name: string }) => c.name === "project")).toMatchObject({ type: "relation", ref: "projects" });
    expect(tasks.columns.find((c: { name: string }) => c.name === "parent")).toMatchObject({ ref: "tasks" });

    // sample records link to each other, with numbers and formulas filled in
    const projects = await records("projects");
    expect(projects.map((p) => p.code).sort()).toEqual(["PRJ-0001", "PRJ-0002"]);
    const review = (await records("tasks")).find((t) => t.title === "Review page copy")!;
    expect(review.project).toBe("Website refresh");
    expect(review.parent).toBe("Design the home page");
    expect((await records("time_logs")).find((l) => l.hours === 4)?.days).toBe(0.5);
    // totals over the samples: time logs -> task hours -> project hours
    const web = projects.find((p) => p.name === "Website refresh")!;
    expect(web).toMatchObject({ hours: 12, open_tasks: 3 });

    const roles = (await admin.get("/api/roles")).body;
    const staff = roles.find((r: { name: string }) => r.name === "Projects · Staff");
    expect(staff).toMatchObject({ appKey: "projects", appLevel: "staff" });
    expect(staff.permissions.time_logs).toMatchObject({ view: true, own: true });
    expect(roles.find((r: { name: string }) => r.name === "Projects · Manager").permissions.tasks).toMatchObject({ delete: true });
    // an app's roles go with the app, not on their own
    expect((await admin.del(`/api/roles/${staff._id}`)).status).toBe(400);

    // installing again is refused
    expect((await admin.post("/api/apps/install", { apps: ["projects"] })).status).toBe(400);
  });

  it("shows the apps' counts on the Home page, for what each person can see", async () => {
    const boards = (await admin.get("/api/apps/dashboards").expect(200)).body;
    const projects = boards.find((b: { app: string }) => b.app === "projects");
    expect(projects.tiles.map((t: { label: string }) => t.label)).toEqual(["Open tasks", "Overdue tasks", "Active projects"]);
    expect(projects.breakdown).toMatchObject({ table: "tasks", column: "status", options: ["To do", "Doing", "Review", "Done"] });
    // a tile's count is the list total with its filters ($today included)
    const count = async (tile: { table: string; filters: object[] }) =>
      (await admin.get(`/api/table/${tile.table}?limit=1&filters=${encodeURIComponent(JSON.stringify(tile.filters))}`).expect(200)).body.total;
    expect(await count(projects.tiles[0])).toBe(4); // samples: 4 not done
    expect(await count(projects.tiles[1])).toBe(0); // none overdue
  });

  it("installs billing: invoices with lines, tax, payments and balance", async () => {
    await admin.post("/api/apps/install", { apps: ["billing"], options: { sampleData: true } }).expect(200);
    const invoices = await records("invoices");
    const byCustomer = Object.fromEntries(invoices.map((i) => [i.customer, i]));
    expect(byCustomer["Acme Traders"]).toMatchObject({ subtotal: 29100, tax: 5238, total: 34338, paid: 10000, balance: 24338 });
    expect(byCustomer["Globex Systems"]).toMatchObject({ total: 14160, balance: 0 });
    expect(String(byCustomer["Acme Traders"].number)).toMatch(/^INV-\d{4}-000[12]$/);
    const invoiceLines = await schema("invoice_lines");
    expect(invoiceLines.columns.find((c: { name: string }) => c.name === "invoice")).toMatchObject({ inline: true });
    expect(invoiceLines.showInMenu).toBe(false); // edited inside invoices
    expect((await records("quotes"))[0]).toMatchObject({ total: 90000 });
    await admin.del("/api/apps/billing").expect(200);
  });

  it("installs inventory: stock on hand on the products; removing it takes those columns away", async () => {
    const plan = (await admin.post("/api/apps/plan", { apps: ["inventory"] })).body;
    expect(plan.extensions).toEqual([expect.objectContaining({ table: "products", columns: expect.arrayContaining(["In stock", "Low stock"]) })]);
    await admin.post("/api/apps/install", { apps: ["inventory"], options: { sampleData: true } }).expect(200);
    const products = Object.fromEntries((await records("products")).map((p) => [p.name, p]));
    expect(products["Barcode scanner"]).toMatchObject({ stock: 14 });
    expect(products["Label rolls (box)"]).toMatchObject({ stock: 1 });
    // a new stock move updates it
    const scanner = products["Barcode scanner"]._id as string;
    await admin.put(`/api/table/products/${scanner}`, { reorder_level: 15 }).expect(200);
    expect((await admin.get(`/api/table/products/${scanner}`)).body).toMatchObject({ stock: 14, low_stock: "Low" });
    await admin.post("/api/table/stock_moves", { product: scanner, type: "In", qty: 10 }).expect(200);
    expect((await admin.get(`/api/table/products/${scanner}`)).body).toMatchObject({ stock: 24, low_stock: "" });
    expect((await records("purchase_orders"))[0]).toMatchObject({ total: 51000 });

    await admin.del("/api/apps/inventory").expect(200);
    const names = (await schema("products")).columns.map((c: { name: string }) => c.name);
    expect(names).not.toContain("stock");
    expect(names).toContain("price");
  });

  it("connects a later app to tables an earlier app made", async () => {
    await admin.post("/api/apps/install", { apps: ["people"], options: { departmentIds: [dept._id], sampleData: true } }).expect(200);
    const plan = (await admin.post("/api/apps/plan", { apps: ["hr"] })).body;
    expect(plan.apps.find((a: { key: string }) => a.key === "people").status).toBe("installed");
    expect(plan.tables.find((t: { key: string }) => t.key === "people.employees").action).toBe("reuse");
    await admin.post("/api/apps/install", { apps: ["hr"], options: { departmentIds: [dept._id], sampleData: true } }).expect(200);
    const leave = await records("leave_requests");
    expect(leave.length).toBe(3);
    expect(leave.find((l) => l.type === "Earned")?.employee).toBe("You (sample)");
  });

  it("tells the sidebar which app each table belongs to (shared apps as one: Company)", async () => {
    const tables = (await admin.get("/api/schema").expect(200)).body as { tableName: string; app: { key: string; name: string; icon: string } | null }[];
    const appOf = (name: string) => tables.find((t) => t.tableName === name)?.app ?? null;
    expect(appOf("tasks")).toMatchObject({ key: "projects", name: "Projects", icon: "IconChecklist" });
    // an app's records are seen by everyone whose role can use the app
    expect((await admin.get("/api/schema/tasks")).body.byDepartment).toBe(false);
    expect(appOf("leave_requests")).toMatchObject({ key: "hr" });
    expect(appOf("employees")).toMatchObject({ key: "company", name: "Company", icon: "IconBuildingSkyscraper" });
    const own = unique("own");
    await admin.post("/api/schema", { tableName: own, columns: [{ name: "name", label: "Name" }] }).expect(200);
    expect((await admin.get(`/api/schema/${own}`)).body.app).toBeNull(); // your own tables: "My tables"
    await admin.del(`/api/schema/${own}`).expect(200);
    // each app's counts go on its app page
    const boards = (await admin.get("/api/apps/dashboards")).body as { app: string; launcher: string }[];
    expect(boards.find((b) => b.app === "projects")?.launcher).toBe("projects");
  });

  it("lets staff see their own HR records through the Employee link", async () => {
    // a Member whose rights come from app access: HR staff, Company (the directory) staff
    const member = (await admin.get("/api/roles")).body.find((r: { name: string }) => r.name === "Member");
    const username = unique("asha").toLowerCase();
    const user = (
      await admin
        .post("/api/users", { username, password: "user-pass-123", roleId: member._id, appAccess: { hr: "staff", company: "staff" } })
        .expect(201)
    ).body.user;
    expect(user.appAccess).toEqual({ hr: "staff", company: "staff" });
    // Asha's employee record gets her login
    const asha = (await records("employees")).find((e) => e.full_name === "Asha Menon")!;
    await admin.put(`/api/table/employees/${asha._id}`, { account: user._id }).expect(200);

    const client = await login(username, "user-pass-123");
    const mine = (await client.get("/api/table/leave_requests")).body.data;
    expect(mine.map((l: { employee: string }) => l.employee)).toEqual(["Asha Menon"]);
    // and she can ask for leave
    await client.post("/api/table/leave_requests", { employee: asha._id, from: "2026-12-01", to: "2026-12-02" }).expect(200);
    expect((await client.get("/api/table/leave_requests")).body.total).toBe(2);
    // but not approve it: that's for managers
    const approved = await client.post("/api/table/leave_requests", { employee: asha._id, from: "2026-12-05", to: "2026-12-05", status: "Approved" });
    expect(approved.status).toBe(400);
    expect(approved.body.errors.status).toMatch(/approval step/);

    // HR's manager can approve, without being a manager anywhere else
    const bossName = unique("boss").toLowerCase();
    await admin
      .post("/api/users", { username: bossName, password: "user-pass-123", roleId: member._id, appAccess: { hr: "manager", company: "staff" } })
      .expect(201);
    const boss = await login(bossName, "user-pass-123");
    await boss.post("/api/table/leave_requests", { employee: asha._id, from: "2026-12-07", to: "2026-12-07", status: "Approved" }).expect(200);
    expect((await boss.get("/api/table/tasks")).status).toBe(404); // no Projects access at all
  });

  it("names a clashing table, or uses yours when asked", async () => {
    await admin.post("/api/schema", { tableName: "deals", columns: [{ name: "title", label: "Title" }] }).expect(200);
    const plan = (await admin.post("/api/apps/plan", { apps: ["crm"] })).body;
    expect(plan.tables.find((t: { key: string }) => t.key === "crm.deals")).toMatchObject({
      tableName: "deals_2",
      conflict: { existing: "deals", choice: "new" },
    });
    await admin.post("/api/apps/install", { apps: ["crm"], options: { conflicts: { "crm.deals": "use" } } }).expect(200);
    const deals = await schema("deals");
    expect(deals.blueprintKey).toBe("crm.deals");
    // your column stays, the app's columns are added
    expect(deals.columns.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["title", "stage", "value", "weighted"]));
  });

  it("won't remove an app another app needs; removes the rest", async () => {
    const res = await admin.del("/api/apps/people");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/HR & leave needs it/);

    await admin.del("/api/apps/hr").expect(200);
    expect((await admin.get("/api/schema/leave_requests")).status).toBe(404);
    // your own table that the app used stays
    await admin.del("/api/apps/crm").expect(200);
    expect((await schema("deals")).blueprintKey).toBeNull();
  });

  it("removes only the sample records", async () => {
    const before = (await admin.get("/api/table/tasks")).body.total;
    await admin.post("/api/table/tasks", { title: "A real task" }).expect(200);
    const res = await admin.del("/api/apps/projects/sample").expect(200);
    expect(res.body.removed).toBeGreaterThanOrEqual(before);
    expect((await records("tasks")).map((t) => t.title)).toEqual(["A real task"]);
  });

  it("an organization type brings departments, which the admin can rename or leave out", async () => {
    await reset();
    const suggested = (await admin.post("/api/apps/plan", { apps: ["org-clinic"] }).expect(200)).body.departments;
    expect(suggested.map((d: { name: string }) => d.name)).toEqual(["Front desk", "Doctors", "Nursing", "Pharmacy", "Accounts"]);

    const reception = unique("Reception"); // "Front desk", renamed
    await admin.post("/api/apps/install", { apps: ["org-clinic"], options: { departments: [reception, "Doctors"] } }).expect(200);
    const names = (await admin.get("/api/departments")).body.map((d: { name: string }) => d.name);
    expect(names).toEqual(expect.arrayContaining([reception, "Doctors"]));
    expect(names).not.toContain("Nursing");
    expect((await schema("patients")).departments.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining([reception, "Doctors"]));
    // next time, the existing ones are reused
    const again = (await admin.post("/api/apps/plan", { apps: ["org-clinic"] })).body.departments;
    expect(again.find((d: { name: string }) => d.name === "Doctors").exists).toBe(true);
    await reset();
  });

  it("sets up every kind of organization, with samples", async () => {
    await reset();
    for (const bundle of BUNDLES) {
      const res = await admin.post("/api/apps/install", { apps: [bundle.key], options: { departmentIds: [dept._id], sampleData: true } });
      expect(res.status, `${bundle.key}: ${res.body.message}`).toBe(200);
      expect(res.body.sampleRecords, bundle.key).toBeGreaterThan(0);
      if (bundle.key === "org-clinic") expect((await records("bills"))[0]).toMatchObject({ total: 850, balance: 550 });
      if (bundle.key === "org-school") {
        expect((await records("marks")).map((m) => m.percent).sort()).toEqual([68, 88]);
        expect((await records("fees")).map((f) => f.balance).sort()).toEqual([0, 9000]);
      }
      if (bundle.key === "org-ngo") {
        const programmes = Object.fromEntries((await records("programmes")).map((p) => [p.name, p]));
        expect(programmes["Evening tuition"]).toMatchObject({ raised: 125000 });
        expect((await records("volunteers"))[0]).toMatchObject({ hours: 4.5 });
      }
      await reset();
    }
  });

  it("cleans up", async () => {
    await reset();
  });
});
