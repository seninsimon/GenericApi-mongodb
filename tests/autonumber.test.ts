import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { login, unique } from "./helpers.js";

// "Auto-number" columns: INV-0001, INV-0002, ... given when a record is created.
describe("Auto-number columns", async () => {
  const admin = await login();
  const t = unique("invoices");
  await admin
    .post("/api/schema", {
      tableName: t,
      columns: [
        { name: "number", label: "Invoice #", type: "autonumber", autonumber: { prefix: "INV-" }, required: true },
        { name: "customer", label: "Customer" },
      ],
    })
    .expect(200);

  const add = async (data: object = {}) => {
    const id = (await admin.post(`/api/table/${t}`, data).expect(200)).body.data.insertedId as string;
    return { id, ...(await admin.get(`/api/table/${t}/${id}`)).body };
  };
  const year = new Date().getFullYear();

  it("numbers new records in order", async () => {
    expect((await add({ customer: "A" })).number).toBe("INV-0001");
    expect((await add({ customer: "B" })).number).toBe("INV-0002");
    // never required: always filled in
    const schema = (await admin.get(`/api/schema/${t}`)).body;
    expect(schema.columns[0]).toMatchObject({ required: false, autonumber: { prefix: "INV-" } });
  });

  it("gives unique numbers to records created at the same time", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => admin.post(`/api/table/${t}`, { customer: `C${i}` }))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const all = (await admin.get(`/api/table/${t}?limit=100`)).body.data.map((r: { number: string }) => r.number);
    expect(new Set(all).size).toBe(52);
    expect(all.sort().at(-1)).toBe("INV-0052");
  });

  it("can't be changed after creation", async () => {
    const r = await add({ customer: "D" });
    await admin.put(`/api/table/${t}/${r.id}`, { number: "INV-9999", customer: "D2" }).expect(200);
    const after = (await admin.get(`/api/table/${t}/${r.id}`)).body;
    expect(after).toMatchObject({ number: r.number, customer: "D2" });
  });

  it("sorts by number", async () => {
    const asc = (await admin.get(`/api/table/${t}?sort=number&order=asc&limit=3`)).body.data;
    expect(asc.map((r: { number: string }) => r.number)).toEqual(["INV-0001", "INV-0002", "INV-0003"]);
  });

  it("uses a new prefix for new records only", async () => {
    await admin.put(`/api/schema/${t}/column/number`, { autonumber: { prefix: "BILL-" } }).expect(200);
    expect((await add()).number).toBe("BILL-0054");
    const first = (await admin.get(`/api/table/${t}?sort=number&order=asc&limit=1`)).body.data[0];
    expect(first.number).toBe("BILL-0054"); // "B" sorts before "I": older ones keep INV-
    await admin.put(`/api/schema/${t}/column/number`, { autonumber: { prefix: "INV-" } }).expect(200);
  });

  it("restarts every year with {YYYY} in the prefix", async () => {
    const po = unique("pos");
    await admin.post("/api/schema", {
      tableName: po,
      columns: [{ name: "ref", label: "PO #", type: "autonumber", autonumber: { prefix: "PO-{YYYY}-" } }, { name: "x", label: "X" }],
    });
    const id = (await admin.post(`/api/table/${po}`, { x: "1" })).body.data.insertedId;
    expect((await admin.get(`/api/table/${po}/${id}`)).body.ref).toBe(`PO-${year}-0001`);
    await admin.del(`/api/schema/${po}`).expect(200);
  });

  it("numbers existing records when the column is added, oldest first", async () => {
    const legacy = unique("legacy");
    await admin.post("/api/schema", { tableName: legacy, columns: [{ name: "name", label: "Name" }] });
    for (const name of ["first", "second", "third"]) await admin.post(`/api/table/${legacy}`, { name });
    await admin
      .post(`/api/schema/${legacy}/column`, { name: "code", label: "Code", type: "autonumber", autonumber: { prefix: "C-" } })
      .expect(200);
    const rows = (await admin.get(`/api/table/${legacy}?sort=code&order=asc`)).body.data;
    expect(rows.map((r: { name: string; code: string }) => `${r.name}=${r.code}`)).toEqual([
      "first=C-0001",
      "second=C-0002",
      "third=C-0003",
    ]);
    const id = (await admin.post(`/api/table/${legacy}`, { name: "fourth" })).body.data.insertedId;
    expect((await admin.get(`/api/table/${legacy}/${id}`)).body.code).toBe("C-0004");

    // deleting the column forgets its counter
    await admin.del(`/api/schema/${legacy}/column/code`).expect(200);
    await admin.post(`/api/schema/${legacy}/column`, { name: "code", type: "autonumber", autonumber: { prefix: "C-" } }).expect(200);
    const again = (await admin.get(`/api/table/${legacy}?sort=code&order=desc&limit=1`)).body.data[0];
    expect(again.code).toBe("C-0004");
    await admin.del(`/api/schema/${legacy}`).expect(200);
  });

  it("keeps numbers from a CSV file and continues after them", async () => {
    const csv = ["Invoice #,Customer", "INV-0100,Imported", ",Numbered for me"].join("\n");
    const start = await admin.upload(`/api/table/${t}/import`).attach("file", Buffer.from(csv), "i.csv");
    await drainJobs();
    expect((await admin.get(`/api/jobs/${start.body.job._id}`)).body.result).toMatchObject({ inserted: 2 });
    const rows = (await admin.get(`/api/table/${t}?search=mport&limit=5`)).body.data;
    expect(rows[0].number).toBe("INV-0100");
    const numbered = (await admin.get(`/api/table/${t}?search=Numbered&limit=5`)).body.data[0];
    expect(numbered.number).toBe("INV-0101");
    expect((await add()).number).toBe("INV-0102");
  });

  it("can't be changed to or from another type", async () => {
    expect((await admin.put(`/api/schema/${t}/column/number`, { type: "text" })).status).toBe(400);
    expect((await admin.put(`/api/schema/${t}/column/customer`, { type: "autonumber" })).status).toBe(400);
  });

  it("cleans up", async () => {
    await admin.del(`/api/schema/${t}`).expect(200);
  });
});
