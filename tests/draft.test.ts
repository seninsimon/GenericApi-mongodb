import { describe, expect, it } from "vitest";
import { fromDraft } from "../src/apps/draft.js";
import { APP_BY_KEY } from "../src/apps/index.js";
import { login } from "./helpers.js";

// Apps drafted with AI: the draft is only data, turned into a checked
// blueprint and installed through the normal preview. No AI is called here.
const col = (name: string, label: string, type: string, more: Record<string, unknown> = {}) => ({
  name,
  label,
  type,
  required: false,
  options: [],
  ref: "",
  prefix: "",
  expression: "",
  ...more,
});
const draft = {
  name: "Dental clinic",
  description: "Patients, appointments and treatments",
  tables: [
    {
      key: "dental_patients",
      label: "Patients",
      description: "Who we treat",
      columns: [col("name", "Name", "text", { required: true }), col("phone", "Phone", "text"), col("insurer", "Insurer", "relation", { ref: "nope" })],
    },
    {
      key: "dental_visits",
      label: "Visits",
      description: "Each visit",
      columns: [
        col("number", "Visit #", "autonumber", { prefix: "VIS-" }),
        col("patient", "Patient", "relation", { ref: "dental_patients", required: true }),
        col("dentist", "Dentist", "user"),
        col("status", "Status", "choice", { options: ["Booked", "Done", "Cancelled"] }),
        col("fee", "Fee", "number"),
        col("discount", "Discount", "number"),
        col("due", "Amount due", "formula", { expression: "{fee} - {discount}" }),
        col("broken", "Broken", "formula", { expression: "{nope} + 1" }),
      ],
    },
  ],
};

describe("Apps drafted with AI", async () => {
  const admin = await login();

  it("turns a draft into a checked blueprint", () => {
    const app = fromDraft(draft);
    expect(app.key).toMatch(/^custom-dental-clinic-[0-9a-f]{6}$/);
    expect(fromDraft(draft).key).toBe(app.key); // same draft, same key
    const [patients, visits] = app.tables;
    // a link to a table that isn't in the draft is left out
    expect(patients.columns.map((c) => c.name)).toEqual(["name", "phone"]);
    // a broken formula is left out; the good one stays
    expect(visits.columns.map((c) => c.name)).toEqual(["number", "patient", "dentist", "status", "fee", "discount", "due"]);
    expect(visits.columns.find((c) => c.name === "status")).toMatchObject({ default: "Booked" });
    expect(() => fromDraft({ name: "x" })).toThrow(/expected shape/);
  });

  it("says clearly when the AI isn't set up", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const res = await admin.post("/api/apps/draft", { description: "A small dental clinic with two dentists" });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/ANTHROPIC_API_KEY/);
    expect((await admin.get("/api/apps")).body.aiDrafts).toBe(false);
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  });

  it("previews, installs, lists and removes a drafted app", async () => {
    for (const t of ["dental_patients", "dental_visits"]) if ((await admin.get(`/api/schema/${t}`)).status === 200) await admin.del(`/api/schema/${t}`);
    const plan = (await admin.post("/api/apps/plan", { apps: [], draft }).expect(200)).body;
    expect(plan.tables.map((t: { tableName: string }) => t.tableName)).toEqual(["dental_patients", "dental_visits"]);

    const result = (await admin.post("/api/apps/install", { apps: [], draft }).expect(200)).body;
    const key = result.apps[0];
    const visits = (await admin.get("/api/schema/dental_visits")).body;
    expect(visits.columns.find((c: { name: string }) => c.name === "patient")).toMatchObject({ ref: "dental_patients" });
    const p = (await admin.post("/api/table/dental_patients", { name: "Anu" }).expect(200)).body.data.insertedId;
    const v = (await admin.post("/api/table/dental_visits", { patient: p, fee: 1500, discount: 200 }).expect(200)).body.data.insertedId;
    expect((await admin.get(`/api/table/dental_visits/${v}`)).body).toMatchObject({ number: "VIS-0001", due: 1300, status: "Booked" });

    // after a restart the app is still known (its draft was kept)
    APP_BY_KEY.delete(key);
    const listed = (await admin.get("/api/apps")).body.apps.find((a: { key: string }) => a.key === key);
    expect(listed).toMatchObject({ name: "Dental clinic", installed: expect.anything() });
    await admin.del(`/api/apps/${key}`).expect(200);
    expect((await admin.get("/api/schema/dental_visits")).status).toBe(404);
  });
});
