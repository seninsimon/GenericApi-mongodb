import { describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs/worker.js";
import { parseFormula } from "../src/schema/formula.js";
import { login, unique } from "./helpers.js";

type Col = { name: string; type: string; formula?: { expression: string; type?: string } };
const f = (name: string, expression: string) => ({ name, label: name, type: "formula", formula: { expression } });

// Formula columns: values worked out from the record's other fields.
describe("Formula columns", async () => {
  const admin = await login();
  const t = unique("payslips");
  await admin
    .post("/api/schema", {
      tableName: t,
      columns: [
        { name: "name", label: "Name" },
        { name: "basic", label: "Basic", type: "number" },
        { name: "allowances", label: "Allowances", type: "number" },
        { name: "deductions", label: "Deductions", type: "number" },
        { name: "from", label: "From", type: "date" },
        { name: "to", label: "To", type: "date" },
        { name: "status", label: "Status", type: "choice", options: ["Draft", "Paid"] },
        { name: "paid", label: "Paid", type: "boolean" },
        f("net", "{basic} + {allowances} - {deductions}"),
        f("days", "DAYS({to}, {from}) + 1"),
        f("title", 'CONCAT({name}, " (", {status}, ")")'),
        f("low", 'IF({net} < 1000, "Low", "")'),
        f("third", "ROUND({net} / 3, 2)"),
        f("per_deduction", "{basic} / {deductions}"),
        f("review_on", "ADD_DAYS({from}, 30)"),
        f("done", "{paid} and not BLANK({name})"),
        f("math", "1 + 2 * 3 - 4 / 2"),
      ],
    })
    .expect(200);

  const add = async (data: object) => {
    const id = (await admin.post(`/api/table/${t}`, data).expect(200)).body.data.insertedId as string;
    return { id, ...(await admin.get(`/api/table/${t}/${id}`)).body };
  };
  const get = async (id: string) => (await admin.get(`/api/table/${t}/${id}`)).body;
  const column = async (name: string): Promise<Col> =>
    (await admin.get(`/api/schema/${t}`)).body.columns.find((c: Col) => c.name === name);

  const anna = await add({
    name: "Anna",
    basic: 30000,
    allowances: 5000,
    deductions: 0,
    from: "2026-03-01",
    to: "2026-03-10",
    status: "Draft",
    paid: true,
  });

  it("works out values when a record is created", () => {
    expect(anna).toMatchObject({
      net: 35000,
      days: 10,
      title: "Anna (Draft)",
      low: "",
      third: 11666.67,
      per_deduction: null, // divided by zero: empty, not an error
      review_on: "2026-03-31",
      done: true,
      math: 5, // 1 + 6 - 2
    });
  });

  it("knows each formula's kind of result", async () => {
    expect((await column("net")).formula).toMatchObject({ type: "number" });
    expect((await column("review_on")).formula).toMatchObject({ type: "date" });
    expect((await column("title")).formula).toMatchObject({ type: "text" });
    expect((await column("done")).formula).toMatchObject({ type: "boolean" });
  });

  it("treats empty numbers as 0 and empty dates as empty", async () => {
    const r = await add({ name: "Ben", basic: 500 });
    expect(r).toMatchObject({ net: 500, low: "Low", days: null, review_on: null, done: false });
  });

  it("updates when the record changes, including formulas using formulas", async () => {
    await admin.put(`/api/table/${t}/${anna.id}`, { basic: 100, allowances: 0 }).expect(200);
    expect(await get(anna.id)).toMatchObject({ net: 100, low: "Low", third: 33.33 });
  });

  it("ignores values sent for formula columns", async () => {
    await admin.put(`/api/table/${t}/${anna.id}`, { net: 999999 }).expect(200);
    expect((await get(anna.id)).net).toBe(100);
  });

  it("recomputes every record when the formula changes", async () => {
    await admin.put(`/api/schema/${t}/column/net`, { formula: { expression: "{basic} * 2" } }).expect(200);
    expect((await get(anna.id)).net).toBe(200);
    // and when a column it uses changes (renaming a label is harmless)
    await admin.put(`/api/schema/${t}/column/basic`, { label: "Basic pay" }).expect(200);
    expect((await get(anna.id)).net).toBe(200);
  });

  it("sorts and filters by the result", async () => {
    const asc = (await admin.get(`/api/table/${t}?sort=net&order=asc`)).body.data.map((r: { name: string }) => r.name);
    expect(asc).toEqual(["Anna", "Ben"]); // 200 < 1000
    const filters = encodeURIComponent(JSON.stringify([{ field: "net", op: "gt", value: 500 }]));
    expect((await admin.get(`/api/table/${t}?filters=${filters}`)).body.data.map((r: { name: string }) => r.name)).toEqual(["Ben"]);
  });

  it("explains mistakes", async () => {
    const bad = async (expression: string) =>
      (await admin.post(`/api/schema/${t}/column`, f(unique("x"), expression))).body.message as string;
    expect(await bad("{bsic} + 1")).toMatch(/Unknown column \{bsic\}/);
    expect(await bad("{Basic pay} + 1")).toMatch(/Did you mean \{basic\}\?/);
    expect(await bad('{name} + 1')).toMatch(/Use CONCAT/);
    expect(await bad("TODAY()")).toMatch(/Unknown function TODAY\(\)/);
    expect(await bad('IF({paid}, 1, "x")')).toMatch(/same kind/);
    expect(await bad("{basic} +")).toMatch(/ends too early/);
    expect(await bad("(1 + 2")).toMatch(/Expected "\)"/);
    expect(await bad("basic * 2")).toMatch(/braces/);
    expect(await bad("{from} + 1")).toMatch(/DAYS/);
  });

  it("refuses formulas that depend on each other in a circle", async () => {
    await admin.post(`/api/schema/${t}/column`, f("double_net", "{net} * 2")).expect(200);
    const res = await admin.put(`/api/schema/${t}/column/net`, { formula: { expression: "{double_net} + 1" } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/circle/);
  });

  it("won't delete a column a formula uses", async () => {
    const res = await admin.del(`/api/schema/${t}/column/basic`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/"Basic pay" is used by the formula "net"/);
    // nor change it into something a formula can't use (ADD_DAYS needs a date)
    const change = await admin.put(`/api/schema/${t}/column/from`, { type: "text" });
    expect(change.status).toBe(400);
    expect(change.body.message).toMatch(/Formula "days": DAYS needs a date, not text/);
  });

  it("checks a formula before saving it, with a sample value", async () => {
    const ok = await admin.post(`/api/schema/${t}/formula/check`, { expression: "{basic} + 1" }).expect(200);
    expect(ok.body).toMatchObject({ type: "number", hasRecords: true });
    expect(typeof ok.body.sample).toBe("number");
    const bad = await admin.post(`/api/schema/${t}/formula/check`, { expression: "{nope}" });
    expect(bad.status).toBe(400);
  });

  it("exports results; imports ignore them", async () => {
    const csv = ["Name,Basic pay,net", "Cara,50,123456"].join("\n");
    const start = await admin.upload(`/api/table/${t}/import`).attach("file", Buffer.from(csv), "p.csv");
    await drainJobs();
    expect((await admin.get(`/api/jobs/${start.body.job._id}`)).body.result).toMatchObject({ inserted: 1 });
    const cara = (await admin.get(`/api/table/${t}?search=Cara`)).body.data[0];
    expect(cara.net).toBe(100); // worked out: 50 * 2

    const exp = await admin.post(`/api/table/${t}/export`);
    await drainJobs();
    const text = (await admin.get(`/api/jobs/${exp.body.job._id}/download`)).text;
    expect(text).toMatch(/Cara,50,,,,,,,100,/);
  });

  it("parses with the usual precedence", () => {
    expect(parseFormula("1 + 2 * 3")).toMatchObject({ op: "+", r: { op: "*" } });
    expect(parseFormula("{a} > 1 and {b} < 2 or {c} = 3")).toMatchObject({ op: "or", l: { op: "and" } });
    expect(parseFormula("-{a} * 2")).toMatchObject({ op: "*", l: { k: "neg" } });
  });

  it("cleans up", async () => {
    await admin.del(`/api/schema/${t}`).expect(200);
  });
});
