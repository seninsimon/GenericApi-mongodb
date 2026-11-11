import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// ?preview=1: the form's live values (formulas, totals, line amounts),
// worked out by a real save that is then rolled back.
describe("Preview saves", async () => {
  const admin = await login();
  const invoices = unique("pv_invoices");
  const lines = unique("pv_lines");
  await admin.post("/api/schema", {
    tableName: invoices,
    columns: [
      { name: "number", label: "Invoice #", type: "autonumber", autonumber: { prefix: "INV-" } },
      { name: "customer", label: "Customer", required: true },
      { name: "tax_pct", label: "Tax %", type: "number" },
    ],
  });
  await admin.post("/api/schema", {
    tableName: lines,
    columns: [
      { name: "invoice", label: "Invoice", type: "relation", ref: invoices, inline: true, required: true },
      { name: "item", label: "Item", required: true },
      { name: "qty", label: "Qty", type: "number" },
      { name: "rate", label: "Rate", type: "number" },
      { name: "amount", label: "Amount", type: "formula", formula: { expression: "{qty} * {rate}" } },
    ],
  });
  await admin.post(`/api/schema/${invoices}/column`, { name: "subtotal", label: "Subtotal", type: "rollup", rollup: { from: lines, via: "invoice", fn: "sum", field: "amount" } });
  await admin.post(`/api/schema/${invoices}/column`, { name: "total", label: "Total", type: "formula", formula: { expression: "{subtotal} * (1 + {tax_pct} / 100)" } });
  const count = async (t: string) => (await admin.get(`/api/table/${t}`)).body.total as number;

  it("works out a new record and its lines, then keeps nothing", async () => {
    const res = await admin
      .post(`/api/table/${invoices}?preview=1`, {
        tax_pct: 10,
        // no customer yet, and a line without an item: still previewed
        _children: { [lines]: { create: [{ qty: 2, rate: 50 }, { item: "B", qty: 1, rate: 30 }] } },
      })
      .expect(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.data).toMatchObject({ subtotal: 130, total: 143 });
    expect(res.body.lines[lines].map((l: { amount: number }) => l.amount)).toEqual([100, 30]);
    expect(await count(invoices)).toBe(0);
    expect(await count(lines)).toBe(0);
    // nothing in the history, and no number used up
    expect((await admin.get(`/api/audit?tableName=${invoices}&action=create&entity=record`)).body.data).toEqual([]);
    const real = await admin.post(`/api/table/${invoices}`, { customer: "Acme", tax_pct: 0 }).expect(200);
    expect((await admin.get(`/api/table/${invoices}/${real.body.data.insertedId}`)).body.number).toBe("INV-0001");
  });

  it("previews changes to a saved record without keeping them", async () => {
    const id = (await admin.get(`/api/table/${invoices}`)).body.data[0]._id;
    await admin.put(`/api/table/${invoices}/${id}`, { _children: { [lines]: { create: [{ item: "A", qty: 1, rate: 100 }] } } }).expect(200);
    const res = await admin
      .put(`/api/table/${invoices}/${id}?preview=1`, { tax_pct: 50, _children: { [lines]: { create: [{ item: "C", qty: 3, rate: 10 }] } } })
      .expect(200);
    expect(res.body.data).toMatchObject({ subtotal: 130, total: 195 });
    expect(res.body.lines[lines].map((l: { item: string }) => l.item)).toEqual(["A", "C"]);
    expect((await admin.get(`/api/table/${invoices}/${id}`)).body).toMatchObject({ subtotal: 100, total: 100, tax_pct: 0 });
    expect(await count(lines)).toBe(1);
  });

  it("still refuses what isn't allowed", async () => {
    const dept = (await admin.post("/api/departments", { name: unique("D") })).body.department;
    await admin.put(`/api/schema/${invoices}`, { departmentIds: [dept._id] });
    const role = (await admin.post("/api/roles", { name: unique("V"), permissions: { [invoices]: { view: true } } })).body.role;
    const username = unique("viewer").toLowerCase();
    await admin.post("/api/users", { username, password: "user-pass-123", roleId: role._id, departmentIds: [dept._id] });
    const viewer = await login(username, "user-pass-123");
    expect((await viewer.post(`/api/table/${invoices}?preview=1`, { customer: "x" })).status).toBe(403);
  });

  it("cleans up", async () => {
    await admin.del(`/api/schema/${invoices}/column/total`);
    await admin.del(`/api/schema/${invoices}/column/subtotal`);
    await admin.del(`/api/schema/${lines}`).expect(200);
    await admin.del(`/api/schema/${invoices}`).expect(200);
  });
});
