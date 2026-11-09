import { describe, expect, it, vi } from "vitest";

// Large tables report an estimated total instead of running count(*).
vi.stubEnv("EXACT_COUNT_LIMIT", "50");

describe("estimated totals on big tables", async () => {
  const { login, unique } = await import("./helpers.js");
  const { query } = await import("../src/db/pool.js");
  const admin = await login();

  it("switches to the planner estimate above EXACT_COUNT_LIMIT", async () => {
    const table = unique("big");
    await admin.post("/api/schema", { tableName: table, columns: [{ name: "n", type: "number" }] }).expect(200);

    const small = await admin.get(`/api/table/${table}`);
    expect(small.body).toMatchObject({ total: 0, totalIsEstimate: false });

    await query(
      `INSERT INTO erp_data."${table}" (data) SELECT jsonb_build_object('n', g) FROM generate_series(1, 500) g`
    );
    await query(`ANALYZE erp_data."${table}"`);

    const big = await admin.get(`/api/table/${table}`);
    expect(big.body.totalIsEstimate).toBe(true);
    expect(big.body.total).toBeGreaterThan(400);
    expect(big.body.total).toBeLessThan(600);
  });
});
