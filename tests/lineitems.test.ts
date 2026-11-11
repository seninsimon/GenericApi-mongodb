import { describe, expect, it } from "vitest";
import { login, unique } from "./helpers.js";

// Line items: an invoice's lines, saved inside the invoice's request.
describe("Line items", async () => {
  const admin = await login();
  const invoices = unique("invoices");
  const lines = unique("lines");
  await admin
    .post("/api/schema", {
      tableName: invoices,
      columns: [
        { name: "number", label: "Invoice #", type: "autonumber", autonumber: { prefix: "INV-" } },
        { name: "customer", label: "Customer" },
        { name: "tax_pct", label: "Tax %", type: "number", default: 10 },
      ],
    })
    .expect(200);
  await admin
    .post("/api/schema", {
      tableName: lines,
      columns: [
        { name: "invoice", label: "Invoice", type: "relation", ref: invoices, inline: true, required: true },
        { name: "item", label: "Item", required: true },
        { name: "qty", label: "Qty", type: "number", default: 1 },
        { name: "rate", label: "Rate", type: "number" },
        { name: "amount", label: "Amount", type: "formula", formula: { expression: "{qty} * {rate}" } },
      ],
    })
    .expect(200);
  await admin
    .post(`/api/schema/${invoices}/column`, { name: "subtotal", label: "Subtotal", type: "rollup", rollup: { from: lines, via: "invoice", fn: "sum", field: "amount" } })
    .expect(200);
  await admin
    .post(`/api/schema/${invoices}/column`, { name: "total", label: "Total", type: "formula", formula: { expression: "ROUND({subtotal} * (1 + {tax_pct} / 100), 2)" } })
    .expect(200);

  const get = async (id: string) => (await admin.get(`/api/table/${invoices}/${id}`)).body;
  const linesOf = async (id: string) => {
    const f = encodeURIComponent(JSON.stringify([{ field: "invoice", op: "in", value: [id] }]));
    return (await admin.get(`/api/table/${lines}?filters=${f}&sort=item&order=asc`)).body.data as Record<string, unknown>[];
  };

  let invoice = "";
  it("creates the invoice with its lines, numbers and totals", async () => {
    const res = await admin
      .post(`/api/table/${invoices}`, {
        customer: "Acme",
        _children: { [lines]: { create: [{ item: "Consulting", qty: 3, rate: 2000 }, { item: "Setup", rate: 500 }] } },
      })
      .expect(200);
    invoice = res.body.data.insertedId;
    expect(await get(invoice)).toMatchObject({ number: "INV-0001", subtotal: 6500, total: 7150 });
    expect((await linesOf(invoice)).map((l) => [l.item, l.qty, l.amount])).toEqual([
      ["Consulting", 3, 6000],
      ["Setup", 1, 500], // qty default
    ]);
  });

  it("reports problems per line and saves nothing", async () => {
    const res = await admin.post(`/api/table/${invoices}`, {
      customer: "Bad",
      _children: { [lines]: { create: [{ item: "Fine", rate: 1 }, { rate: 5 }] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[`${lines}.create.1.item`]).toMatch(/Item is required/);
    expect((await admin.get(`/api/table/${invoices}?search=Bad`)).body.total).toBe(0);
  });

  it("adds, changes and removes lines when the invoice is saved", async () => {
    const [consulting, setup] = await linesOf(invoice);
    await admin
      .put(`/api/table/${invoices}/${invoice}`, {
        tax_pct: 0,
        _children: {
          [lines]: {
            create: [{ item: "Training", qty: 2, rate: 1500 }],
            update: [{ _id: consulting._id, qty: 1 }],
            delete: [setup._id],
          },
        },
      })
      .expect(200);
    expect(await get(invoice)).toMatchObject({ subtotal: 5000, total: 5000 });
    expect((await linesOf(invoice)).map((l) => l.item)).toEqual(["Consulting", "Training"]);
  });

  it("only touches this invoice's lines", async () => {
    const other = (await admin.post(`/api/table/${invoices}`, { customer: "Other", _children: { [lines]: { create: [{ item: "X", rate: 1 }] } } }))
      .body.data.insertedId;
    const [x] = await linesOf(other);
    const res = await admin.put(`/api/table/${invoices}/${invoice}`, { _children: { [lines]: { update: [{ _id: x._id, qty: 99 }] } } });
    expect(res.status).toBe(400);
    expect(res.body.errors[`${lines}.update.0._id`]).toBe("Line not found");
    // a table whose link isn't edited inline
    expect((await admin.put(`/api/table/${invoices}/${invoice}`, { _children: { [invoices]: {} } })).status).toBe(400);
  });

  it("checks permission on the lines", async () => {
    const dept = (await admin.post("/api/departments", { name: unique("Acc") })).body.department;
    await admin.put(`/api/schema/${invoices}`, { departmentIds: [dept._id] });
    await admin.put(`/api/schema/${lines}`, { departmentIds: [dept._id] });
    const role = (await admin.post("/api/roles", { name: unique("Clerk"), permissions: { [invoices]: { view: true, create: true }, [lines]: { view: true } } }))
      .body.role;
    const username = unique("clerk").toLowerCase();
    await admin.post("/api/users", { username, password: "user-pass-123", roleId: role._id, departmentIds: [dept._id] });
    const clerk = await login(username, "user-pass-123");
    const res = await clerk.post(`/api/table/${invoices}`, { customer: "C", _children: { [lines]: { create: [{ item: "Y", rate: 1 }] } } });
    expect(res.status).toBe(403);
  });

  it("deletes the lines with the invoice", async () => {
    await admin.del(`/api/table/${invoices}/${invoice}`).expect(200);
    expect(await linesOf(invoice)).toEqual([]);
  });

  it("cleans up", async () => {
    await admin.del(`/api/schema/${invoices}/column/total`).expect(200);
    await admin.del(`/api/schema/${invoices}/column/subtotal`).expect(200);
    await admin.del(`/api/schema/${lines}`).expect(200);
    await admin.del(`/api/schema/${invoices}`).expect(200);
  });
});
