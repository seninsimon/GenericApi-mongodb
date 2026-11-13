import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { checkLimits, recordUsage } from "../src/ai/usage.js";
import { login, unique } from "./helpers.js";

// workspace/AI_PLAN.md: the admin picks the AI that drafts apps and pastes its
// key in Administration → AI. The providers are never really called here:
// fetch is replaced with canned answers.
const KEY_G = "AIzaTEST-gemini-key-0123456789abcdef";
const KEY_O = "sk-TEST-openai-key-0123456789abcdef";

const col = (name: string, label: string, type: string) => ({ name, label, type, required: false, options: [], ref: "", prefix: "", expression: "" });
const DRAFT = {
  name: "Bakery",
  description: "Orders and products for a bakery",
  tables: [{ key: "cakes", label: "Cakes", description: "What we bake", columns: [col("name", "Name", "text"), col("price", "Price", "number")] }],
};

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const calls: Call[] = [];
const answer = (status: number, body: unknown) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    })
  );
};
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("AI settings", async () => {
  const admin = await login();
  const description = "A bakery with two shops that takes cake orders";
  afterAll(async () => {
    await admin.put("/api/ai", { features: { draftApps: true }, limits: { monthlyUsd: null, perPersonDaily: null } });
    for (const provider of ["gemini", "openai", "anthropic"]) await admin.put("/api/ai", { provider, removeKey: true });
  });

  it("starts not set up, and says where to set it up", async () => {
    const ai = (await admin.get("/api/ai").expect(200)).body;
    expect(ai).toMatchObject({ provider: "anthropic", ready: false, hasKey: { anthropic: false, gemini: false, openai: false } });
    expect(ai.defaultModels).toMatchObject({ gemini: "gemini-4-hydrogen", openai: "gpt-6.1-sol" });
    expect((await admin.post("/api/ai/test")).status).toBe(400);
    const username = unique("member").toLowerCase();
    const role = (await admin.post("/api/roles", { name: unique("Plain"), permissions: {} })).body.role;
    await admin.post("/api/users", { username, fullName: "M", email: `${username}@example.com`, password: "pass-123-pass", roleId: role._id }).expect(201);
    expect((await (await login(username, "pass-123-pass")).get("/api/ai")).status).toBe(403);
  });

  it("keeps the key to itself", async () => {
    expect((await admin.put("/api/ai", { provider: "gemini", key: "short" })).status).toBe(400);
    const res = await admin.put("/api/ai", { provider: "gemini", key: KEY_G }).expect(200);
    expect(res.body.settings).toMatchObject({ provider: "gemini", ready: true, hasKey: { gemini: true } });
    const seen = JSON.stringify([res.body, (await admin.get("/api/ai")).body, (await admin.get("/api/audit")).body]);
    expect(seen).not.toContain(KEY_G);
    expect((await admin.get("/api/apps")).body.aiDrafts).toBe(true);
  });

  it("drafts with Gemini", async () => {
    answer(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(DRAFT) }] } }] });
    const res = await admin.post("/api/apps/draft", { description }).expect(200);
    expect(res.body.app.name).toBe("Bakery");
    const [call] = calls;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent");
    expect(call.headers["x-goog-api-key"]).toBe(KEY_G);
    const config = call.body.generationConfig as { responseMimeType: string; responseJsonSchema: Record<string, unknown> };
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toMatchObject({ type: "object", required: ["name", "description", "tables"] });
    expect(config.responseJsonSchema.$schema).toBeUndefined();
  });

  it("drafts with ChatGPT, keeping Gemini's key for later", async () => {
    await admin.put("/api/ai", { provider: "gemini", model: "gemini-3.8-flash" }).expect(200);
    const res = (await admin.put("/api/ai", { provider: "openai", key: KEY_O }).expect(200)).body.settings;
    expect(res).toMatchObject({ provider: "openai", model: "", hasKey: { gemini: true, openai: true } }); // the model went back to our pick
    answer(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(DRAFT), refusal: null } }] });
    await admin.post("/api/apps/draft", { description }).expect(200);
    const [call] = calls;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.headers.Authorization).toBe(`Bearer ${KEY_O}`);
    expect(call.body).toMatchObject({ model: "gpt-6.1-sol", response_format: { type: "json_schema", json_schema: { name: "app_draft", strict: true } } });
  });

  it("explains what went wrong, in plain words", async () => {
    answer(401, { error: { message: "Incorrect API key provided" } });
    let res = await admin.post("/api/apps/draft", { description });
    expect(res.status).toBe(503);
    expect(res.body.message).toBe("ChatGPT refused the API key. Check it in Administration → AI.");

    answer(404, { error: { message: "The model `gpt-0` does not exist" } });
    await admin.put("/api/ai", { provider: "openai", model: "gpt-0" }).expect(200);
    res = await admin.post("/api/ai/test");
    expect(res.body.message).toMatch(/doesn't offer the model "gpt-0"/);
    await admin.put("/api/ai", { provider: "openai", model: "" }).expect(200);

    answer(429, { error: { message: "You exceeded your current quota" } });
    expect((await admin.post("/api/apps/draft", { description })).status).toBe(429);

    answer(200, { choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't help with that" } }] });
    expect((await admin.post("/api/apps/draft", { description })).status).toBe(422);

    answer(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ name: "x" }) } }] });
    res = await admin.post("/api/apps/draft", { description });
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/expected shape/);
  });

  it("tests the key, and forgets it on request", async () => {
    answer(200, { choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
    expect((await admin.post("/api/ai/test").expect(200)).body.message).toBe("ChatGPT is working (gpt-6.1-sol)");
    const res = (await admin.put("/api/ai", { provider: "openai", removeKey: true }).expect(200)).body.settings;
    expect(res).toMatchObject({ ready: false, hasKey: { openai: false, gemini: true } });
    expect((await admin.get("/api/apps")).body.aiDrafts).toBe(false);
  });

  describe("features, usage and limits (AI_FEATURES_PLAN.md)", () => {
    const usage = async () => (await admin.get("/api/ai/usage").expect(200)).body;
    // a Gemini draft that used 2,000 tokens in and 3,000 + 1,000 thinking out
    const geminiDraft = () =>
      answer(200, {
        usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 3000, thoughtsTokenCount: 1000 },
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(DRAFT) }] } }],
      });
    const bell = async () => ((await admin.get("/api/notifications")).body.items as { title: string }[]).map((n) => n.title);

    it("drafting has a switch", async () => {
      await admin.put("/api/ai", { provider: "gemini" }).expect(200); // its key is still there
      const res = (await admin.put("/api/ai", { features: { draftApps: false } }).expect(200)).body.settings;
      expect(res.features).toMatchObject({ draftApps: false });
      expect((await admin.get("/api/apps")).body.aiDrafts).toBe(false);
      const draft = await admin.post("/api/apps/draft", { description });
      expect(draft.status).toBe(403);
      expect(draft.body.message).toMatch(/switched off/);
      await admin.put("/api/ai", { features: { draftApps: true } }).expect(200);
      expect((await admin.get("/api/apps")).body).toMatchObject({ aiDrafts: true, aiName: "Gemini" });
    });

    it("counts every request with an estimated cost, never what was asked", async () => {
      const before = await usage();
      geminiDraft();
      await admin.post("/api/apps/draft", { description }).expect(200);
      const after = await usage();
      expect(after.month.requests - before.month.requests).toBe(1);
      expect(after.month.inputTokens - before.month.inputTokens).toBe(2000);
      expect(after.month.outputTokens - before.month.outputTokens).toBe(4000); // thinking is billed as output
      // gemini-4-hydrogen: 2,000 × $1.50 + 4,000 × $7.50 per million = $0.033
      expect(after.month.costUsd - before.month.costUsd).toBeCloseTo(0.033, 6);
      expect(after.byFeature.find((f: { feature: string }) => f.feature === "draftApps")).toBeTruthy();
      expect(after.byPerson[0]).toMatchObject({ name: expect.any(String) });
      expect(JSON.stringify(after)).not.toContain("bakery");
      // a failed request counts too (the provider may still bill it)
      answer(500, { error: { message: "internal" } });
      expect((await admin.post("/api/apps/draft", { description })).status).toBe(502);
      const failed = await usage();
      expect(failed.month.failed - after.month.failed).toBe(1);
    });

    it("a model without a known price shows tokens but no cost", async () => {
      await admin.put("/api/ai", { provider: "gemini", model: "gemini-9-custom" }).expect(200);
      const before = await usage();
      geminiDraft();
      await admin.post("/api/apps/draft", { description }).expect(200);
      const after = await usage();
      expect(after.month.unpriced - before.month.unpriced).toBe(1);
      expect(after.month.costUsd).toBeCloseTo(before.month.costUsd, 6);
      await admin.put("/api/ai", { provider: "gemini", model: "" }).expect(200);
    });

    it("the monthly limit warns the admins at 80%, then pauses AI", async () => {
      expect((await admin.put("/api/ai", { limits: { monthlyUsd: -5 } })).status).toBe(400);
      const spent = (await usage()).month.costUsd;
      // a limit just above this month's spend: 80% is already passed
      await admin.put("/api/ai", { limits: { monthlyUsd: spent + 0.005 } }).expect(200);
      answer(200, { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 }, candidates: [{ finishReason: "STOP", content: { parts: [{ text: "OK" }] } }] });
      await admin.post("/api/ai/test").expect(200);
      expect(await bell()).toContain("AI spending is at 80% of this month's limit");
      geminiDraft(); // still under the limit, so it runs, and goes over
      await admin.post("/api/apps/draft", { description }).expect(200);
      expect(await bell()).toContain("AI features paused: this month's limit is reached");
      geminiDraft();
      const res = await admin.post("/api/apps/draft", { description });
      expect(res.status).toBe(429);
      expect(res.body.message).toBe("This month's AI limit is reached. An admin can raise it in Administration → AI.");
      await admin.put("/api/ai", { limits: { monthlyUsd: null } }).expect(200);
    });

    it("the daily limit per person leaves admins alone", async () => {
      const username = unique("asker").toLowerCase();
      const role = (await admin.post("/api/roles", { name: unique("Asker"), permissions: {} })).body.role;
      const member = (await admin.post("/api/users", { username, fullName: "Asker", email: `${username}@example.com`, password: "pass-123-pass", roleId: role._id }).expect(201)).body.user;
      await admin.put("/api/ai", { limits: { perPersonDaily: 2 } }).expect(200);
      const who = { _id: member._id as string, isAdmin: false };
      for (let i = 0; i < 2; i++) {
        await checkLimits(who);
        await recordUsage({ feature: "draftApps", who, provider: "gemini", model: "gemini-4-hydrogen", inputTokens: 10, outputTokens: 10, ok: true });
      }
      await expect(checkLimits(who)).rejects.toThrow("You've reached today's limit for AI features. Try again tomorrow.");
      await expect(checkLimits({ _id: member._id, isAdmin: true })).resolves.toBeUndefined();
      await admin.put("/api/ai", { limits: { perPersonDaily: null } }).expect(200);
      await expect(checkLimits(who)).resolves.toBeUndefined();
    });
  });
});
