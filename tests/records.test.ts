import { describe, expect, it } from "vitest";
import { query } from "../src/db/pool.js";
import { login, setupWorld, unique } from "./helpers.js";

describe("records: validation, search, sorting, options, audit", async () => {
  const admin = await login();
  const ref = unique("people");
  await admin.post("/api/schema", { tableName: ref, columns: [{ name: "name", label: "Name" }] }).expect(200);

  const world = await setupWorld(admin, {
    columns: [
      { name: "title", label: "Title", required: true },
      { name: "price", label: "Price", type: "number", indexed: true },
      { name: "done", label: "Done", type: "boolean" },
      { name: "due", label: "Due", type: "date" },
      { name: "notes", label: "Notes", type: "richtext", required: true },
      { name: "owner", label: "Owner", type: "relation", ref },
      { name: "photo", label: "Photo", type: "image" },
    ],
  });
  await admin.put(`/api/schema/${ref}`, { departmentIds: [world.dept._id] });
  await admin.put(`/api/roles/${world.role._id}`, {
    permissions: { [world.table]: { view: true, create: true, edit: true, delete: true }, [ref]: { view: true } },
  });
  const ann = (await admin.post(`/api/table/${ref}`, { name: "Ann", _departmentId: world.dept._id })).body.data.insertedId;
  const t = world.table;
  const valid = { title: "First", price: 10, notes: "<p>hi</p>" };

  it("validates types and required fields with per-field errors", async () => {
    const res = await world.user.post(`/api/table/${t}`, {
      price: "abc",
      done: "maybe",
      due: "yesterday",
      notes: "<p></p>",
      photo: "http://evil/x.png",
    });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.errors).sort()).toEqual(["done", "due", "notes", "photo", "price", "title"]);
  });

  it("coerces numeric strings and ignores unknown keys", async () => {
    const res = await world.user.post(`/api/table/${t}`, { ...valid, price: "12.5", hacker: "x" });
    expect(res.status).toBe(200);
    const record = (await world.user.get(`/api/table/${t}/${res.body.data.insertedId}`)).body;
    expect(record.price).toBe(12.5);
    expect(record).not.toHaveProperty("hacker");
  });

  it("checks that linked records exist", async () => {
    expect((await world.user.post(`/api/table/${t}`, { ...valid, owner: "no-such-id" })).body.errors.owner).toMatch(/not found/);
    expect((await world.user.post(`/api/table/${t}`, { ...valid, owner: ann })).status).toBe(200);
  });

  it("keeps required fields on partial updates", async () => {
    const id = (await world.user.post(`/api/table/${t}`, valid)).body.data.insertedId;
    expect((await world.user.put(`/api/table/${t}/${id}`, { price: 3 })).status).toBe(200);
    expect((await world.user.put(`/api/table/${t}/${id}`, { title: "" })).body.errors.title).toMatch(/required/);
  });

  it("sorts numbers numerically using the sort index", async () => {
    for (const price of [100, 9, 25]) await world.user.post(`/api/table/${t}`, { ...valid, title: `p${price}`, price });
    const res = await world.user.get(`/api/table/${t}?sort=Price&order=asc&limit=100`);
    const prices = res.body.data.map((r: { Price: number }) => r.Price).filter((p: unknown) => p != null);
    expect(prices).toEqual([...prices].sort((a: number, b: number) => a - b));

    const { rows } = await query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'erp_data' AND tablename = $1`, [t]);
    expect(rows.some((r) => /erp_try_numeric/.test(r.indexdef))).toBe(true); // price sort index
    expect(rows.some((r) => /gin_trgm_ops/.test(r.indexdef))).toBe(true); // search index
  });

  it("number sorting works in parallel query plans (big tables)", async () => {
    // force a parallel plan, as Postgres picks for large tables
    const { pool } = await import("../src/db/pool.js");
    const client = await pool.connect();
    try {
      await client.query("SET parallel_setup_cost = 0; SET parallel_tuple_cost = 0; SET min_parallel_table_scan_size = 0");
      const { rows } = await client.query(
        `SELECT erp_try_numeric(data ->> 'price') AS p FROM erp_data."${t}" ORDER BY 1 DESC NULLS LAST`
      );
      expect(rows.length).toBeGreaterThan(0);
      const { rows: parsed } = await client.query(
        `SELECT erp_try_numeric(v) AS n FROM unnest(ARRAY['12', '-3.5', '1e3', 'abc', '', ' 7 ', '1e99999']) v`
      );
      expect(parsed.map((r) => (r.n === null ? null : Number(r.n)))).toEqual([12, -3.5, 1000, null, null, 7, null]);
    } finally {
      client.release();
    }
  });

  it("searches with the trigram index and strips HTML in previews", async () => {
    await world.user.post(`/api/table/${t}`, { ...valid, title: "Quarterly zebra plan", notes: "<h2>Big &amp; bold</h2>" });
    const res = await world.user.get(`/api/table/${t}?search=ZEBRA`);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].Notes).toBe("Big & bold");
    expect(res.body.totalIsEstimate).toBe(false);
  });

  it("serves relation options by search and by id", async () => {
    for (const name of ["Bob", "Bea", "Carl"]) {
      await admin.post(`/api/table/${ref}`, { name, _departmentId: world.dept._id });
    }
    const search = await world.user.get(`/api/table/${ref}/options?search=b&limit=1`);
    expect(search.body).toHaveLength(1);
    const byId = await world.user.get(`/api/table/${ref}/options?ids=${ann}`);
    expect(byId.body).toEqual([{ value: ann, label: "Ann" }]);
  });

  it("writes an audit trail and lets viewers read a record's history", async () => {
    const id = (await world.user.post(`/api/table/${t}`, { ...valid, title: "Audited" })).body.data.insertedId;
    await world.user.put(`/api/table/${t}/${id}`, { title: "Audited v2" });
    const history = await world.user.get(`/api/audit?tableName=${t}&recordId=${id}`);
    expect(history.status).toBe(200);
    expect(history.body.data.map((e: { action: string }) => e.action)).toEqual(["update", "create"]);
    expect(history.body.data[0].changes.title).toEqual({ from: "Audited", to: "Audited v2" });

    await world.user.del(`/api/table/${t}/${id}`).expect(200);
    const all = await admin.get(`/api/audit?tableName=${t}&action=delete`);
    expect(all.body.data[0]).toMatchObject({ recordId: id, entity: "record", username: world.username });
    // non-admins can't browse the whole log
    expect((await world.user.get(`/api/audit?tableName=${t}`)).status).toBe(403);
  });

  it("rejects indexes on unsupported column types and accepts the richText spelling", async () => {
    expect((await admin.post(`/api/schema/${t}/column`, { name: "pics", type: "images", indexed: true })).status).toBe(400);
    const res = await admin.post(`/api/schema/${t}/column`, { name: "body2", type: "richText" });
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe("richtext");
    expect((await admin.post(`/api/schema/${t}/column`, { name: "body2" })).status).toBe(409);
  });
});
