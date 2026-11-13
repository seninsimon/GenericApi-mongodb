import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { login, unique } from "./helpers.js";

// Ask Zenin (workspace/AI_FEATURES_PLAN.md, Part 3). The AI providers are never
// really called: fetch is replaced with scripted answers, one per round.
type Call = { url: string; body: Record<string, unknown> };
const calls: Call[] = [];
const script = (...answers: unknown[]) => {
  const queue = [...answers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify(queue.shift() ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
};
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

const geminiCall = (name: string, args: unknown) => ({
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 100 },
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { id: "c1", name, args }, thoughtSignature: "sig-123" }] } }],
});
const geminiText = (text: string) => ({
  usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 80 },
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }],
});

describe("Ask Zenin", async () => {
  const admin = await login();
  const dept = async (name: string) => (await admin.post("/api/departments", { name: unique(name) })).body.department;
  const eng = await dept("Eng");
  const hr = await dept("HR");
  const table = unique("tickets");
  await admin.post("/api/schema", {
    tableName: table,
    byDepartment: true,
    columns: [
      { name: "title", label: "Title" },
      { name: "status", label: "Status", type: "choice", options: [{ label: "Open" }, { label: "Closed" }] },
    ],
  }).expect(200);
  await admin.put(`/api/schema/${table}`, { departmentIds: [eng._id, hr._id] }).expect(200);
  const role = (await admin.post("/api/roles", { name: unique("Staff"), permissions: { [table]: { view: true, create: true } } })).body.role;
  const other = (await admin.post("/api/roles", { name: unique("Other"), permissions: {} })).body.role;
  const username = unique("sam").toLowerCase();
  const samId = (await admin.post("/api/users", { username, fullName: "Sam Ito", email: `${username}@example.com`, password: "pass-123-pass", roleId: role._id, departmentIds: [eng._id] }).expect(201)).body.user._id;
  const sam = await login(username, "pass-123-pass");
  for (const [title, status, d] of [["Printer jam", "Open", eng], ["VPN down", "Open", eng], ["Payroll question", "Open", hr], ["Old laptop", "Closed", eng]] as const) {
    await admin.post(`/api/table/${table}`, { title, status, _departmentIds: [d._id] }).expect(200);
  }
  const question = (content: string) => ({ turns: [{ role: "user", content }] });

  afterAll(async () => {
    await admin.put("/api/ai", { features: { askZenin: false }, askRoles: [], limits: { perPersonDaily: null } });
    await admin.put("/api/ai", { provider: "gemini", removeKey: true });
    await admin.put("/api/ai", { provider: "openai", removeKey: true });
  });

  it("is off until an admin switches it on, and then for the chosen roles", async () => {
    await admin.put("/api/ai", { provider: "gemini", key: "AIzaTEST-gemini-key-0123456789abcdef" }).expect(200);
    expect((await sam.get("/api/ai/assistant")).body.available).toBe(false);
    expect((await sam.post("/api/ai/ask", question("hi"))).status).toBe(403);

    await admin.put("/api/ai", { features: { askZenin: true } }).expect(200);
    expect((await sam.get("/api/ai/assistant")).body.available).toBe(true); // everyone
    await admin.put("/api/ai", { askRoles: [other._id] }).expect(200);
    expect((await sam.get("/api/ai/assistant")).body.available).toBe(false);
    expect((await admin.get("/api/ai/assistant")).body.available).toBe(true); // admins always
    await admin.put("/api/ai", { askRoles: [role._id] }).expect(200);
    expect((await sam.get("/api/ai/assistant")).body.available).toBe(true);
  });

  it("searches with the asker's permissions (Gemini)", async () => {
    script(
      geminiCall("search_records", { table, filters: [{ field: "status", op: "in", values: ["Open"] }] }),
      geminiText("You have 2 open tickets: [Printer jam](/table/x/1) and [VPN down](/table/x/2).")
    );
    const res = await sam.post("/api/ai/ask", question("Which tickets are open?")).expect(200);
    expect(res.body.answer).toMatch(/2 open tickets/);

    // round 1: Sam's tables are described, with the choice options; HR's records aren't
    const first = calls[0].body as { systemInstruction: { parts: { text: string }[] }; tools: unknown[] };
    expect(calls[0].url).toContain("gemini-4-hydrogen:generateContent");
    expect(first.systemInstruction.parts[0].text).toContain(`${table} (`);
    expect(first.systemInstruction.parts[0].text).toContain("options: Open | Closed");
    expect(first.systemInstruction.parts[0].text).toContain("Sam Ito");

    // round 2: the model's turn went back unchanged (signature included), then the result
    const second = calls[1].body as { contents: { role: string; parts: Record<string, unknown>[] }[] };
    const [, modelTurn, toolTurn] = second.contents;
    expect(modelTurn).toEqual({ role: "model", parts: [{ functionCall: { id: "c1", name: "search_records", args: expect.any(Object) }, thoughtSignature: "sig-123" }] });
    const result = (toolTurn.parts[0].functionResponse as { id: string; response: { result: { total: number; records: { title: string; link: string }[] } } });
    expect(result.id).toBe("c1");
    expect(result.response.result.total).toBe(2);
    const titles = result.response.result.records.map((r) => r.title).sort();
    expect(titles).toEqual(["Printer jam", "VPN down"]); // not HR's "Payroll question"
    expect(result.response.result.records[0].link).toMatch(new RegExp(`^/table/${table}/`));
  });

  it("tells the AI what went wrong, so it can try again", async () => {
    script(
      geminiCall("search_records", { table: "salaries" }),
      geminiCall("search_records", { table, filters: [{ field: "status", op: "gt", value: "1" }] }),
      geminiText("I couldn't find that.")
    );
    await sam.post("/api/ai/ask", question("Show salaries")).expect(200);
    const errorOf = (i: number) => {
      const contents = (calls[i].body as { contents: { parts: { functionResponse?: { response: { error?: string } } }[] }[] }).contents;
      return contents.at(-1)!.parts[0].functionResponse!.response.error;
    };
    expect(errorOf(1)).toMatch(/no table "salaries" you can see/);
    expect(errorOf(2)).toMatch(/"gt" can't be used on "status"/);
  });

  it("counts one request per question, all rounds added up", async () => {
    const before = (await admin.get("/api/ai/usage")).body.byFeature.find((f: { feature: string }) => f.feature === "askZenin");
    script(geminiCall("search_records", { table }), geminiText("Done."));
    await sam.post("/api/ai/ask", question("How many tickets?")).expect(200);
    const usage = (await admin.get("/api/ai/usage")).body;
    const after = usage.byFeature.find((f: { feature: string }) => f.feature === "askZenin");
    expect(after.requests - (before?.requests ?? 0)).toBe(1);
    // 2,500 in + 230 out at gemini-4-hydrogen prices
    expect(after.costUsd - (before?.costUsd ?? 0)).toBeCloseTo((2500 * 1.5 + 230 * 7.5) / 1e6, 6);
    expect(usage.byPerson.some((p: { name: string }) => p.name === "Sam Ito")).toBe(true);
  });

  it("works the same with ChatGPT, and finds people by name", async () => {
    await admin.put("/api/ai", { provider: "openai", key: "sk-TEST-openai-key-0123456789abcdef" }).expect(200);
    const toolCall = (id: string, name: string, args: unknown) => ({
      usage: { prompt_tokens: 900, completion_tokens: 40 },
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
    });
    script(
      toolCall("t1", "find_people", { name: "Sam" }),
      toolCall("t2", "search_records", { table, filters: [{ field: "_createdBy", op: "in", values: ["$me"] }] }),
      { usage: { prompt_tokens: 1200, completion_tokens: 60 }, choices: [{ finish_reason: "stop", message: { content: "Sam is Sam Ito." } }] }
    );
    const res = await sam.post("/api/ai/ask", { turns: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello!" }, { role: "user", content: "Who is Sam?" }] }).expect(200);
    expect(res.body.answer).toBe("Sam is Sam Ito.");
    const first = calls[0].body as { model: string; messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
    expect(first.model).toBe("gpt-6.1-sol");
    expect(first.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]); // the earlier turns came along
    expect(first.tools.map((t) => t.function.name)).toEqual(["search_records", "find_people"]);
    const second = calls[1].body as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const people = JSON.parse(second.messages.at(-1)!.content);
    expect(second.messages.at(-1)!.tool_call_id).toBe("t1");
    expect(people).toEqual(expect.arrayContaining([expect.objectContaining({ id: samId, name: "Sam Ito" })]));
    await admin.put("/api/ai", { provider: "gemini" }).expect(200);
  });

  it("checks the question and the daily limit", async () => {
    expect((await sam.post("/api/ai/ask", { turns: [] })).status).toBe(400);
    expect((await sam.post("/api/ai/ask", { turns: [{ role: "assistant", content: "hi" }] })).status).toBe(400);
    await admin.put("/api/ai", { limits: { perPersonDaily: 1 } }).expect(200); // Sam has asked several times today
    const res = await sam.post("/api/ai/ask", question("One more?"));
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/today's limit/);
  });
});
