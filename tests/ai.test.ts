import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
});
