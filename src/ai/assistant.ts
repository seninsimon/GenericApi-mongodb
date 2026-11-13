import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { can, isAdmin } from "../auth/access.js";
import { listForUser } from "../controllers/records.js";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { searchUserOptions } from "../repo/userRepo.js";
import { pickDisplayField, valueType } from "../schema/columns.js";
import { getAllSchemas, getSchema } from "../schema/schemaRepo.js";
import type { Column, CurrentUser, TableSchema } from "../types.js";
import { failed, metered, post, refused, TIMEOUT_MS, type Ai, type Meter } from "./generate.js";
import { activeAi, getAiSettings } from "./settings.js";
import { checkLimits } from "./usage.js";
import { brandName } from "../branding.js";

// Ask Zenin (workspace/AI_FEATURES_PLAN.md, Part 3): questions about the ERP's
// data, answered by the AI chosen in Administration → AI. Read-only. The AI
// searches with the asking person's permissions, through the same code as
// the record lists, so it can only see what they can see. Conversations
// aren't kept on the server: the browser sends the last turns each time.

export type Turn = { role: "user" | "assistant"; content: string };

const MAX_ROUNDS = 6; // tool rounds per question
const MAX_TURNS = 12; // earlier turns sent back for context
const RESULT_LIMIT = 25;

/* ---------------- who may use it ---------------- */

export async function canAsk(user: CurrentUser) {
  const s = await getAiSettings();
  if (!s.keys[s.provider] || !s.features.askZenin) return false;
  if (isAdmin(user) || !s.askRoles.length) return true;
  return user.roleIds.some((id) => s.askRoles.includes(id));
}

/* ---------------- the tools ---------------- */

// every value is text (numbers too), a list for in / notIn: simple types
// every provider's schema format accepts
const Scalar = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const FilterInput = z.object({
  field: z.string(),
  op: z.string(),
  value: Scalar.optional(),
  values: z.array(Scalar).max(100).optional(),
  value2: Scalar.optional(),
});
const SearchInput = z.object({
  table: z.string(),
  search: z.string().max(200).optional(),
  filters: z.array(FilterInput).max(20).optional(),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(RESULT_LIMIT).optional(),
});
const PeopleInput = z.object({ name: z.string().max(100) });

type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };

const TOOLS: ToolDef[] = [
  {
    name: "search_records",
    description:
      "Find records in one table, as the person asking can see them. Returns the total number that match and up to `limit` records " +
      "(each with _id, link, and its fields; links and people are shown by name). Use filters for exact questions (status, dates, " +
      "people), search for words anywhere in a record. To count, read `total`.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "the table's key, from the list of tables" },
        search: { type: "string", description: "words to look for anywhere in the record" },
        filters: {
          type: "array",
          description: "all must match",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "a column's key, or _createdBy / _department" },
              op: { type: "string", description: "an operator allowed for the column's type (see the instructions)" },
              value: { type: "string", description: "one value: text, a number, or a date (YYYY-MM-DD, $today, $today+7, $today-30)" },
              values: { type: "array", items: { type: "string" }, description: "for in / notIn: the list of values" },
              value2: { type: "string", description: "the second value, for between" },
            },
            required: ["field", "op"],
          },
        },
        sort: { type: "string", description: "a column's key, or _createdAt / _updatedAt (default: newest first)" },
        order: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "integer", description: `how many records to return, 1 to ${RESULT_LIMIT} (default 10)` },
      },
      required: ["table"],
    },
  },
  {
    name: "find_people",
    description: "Find people (accounts) by name, to filter a User column or _createdBy by them. Returns their ids.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "part of the person's name or username" } },
      required: ["name"],
    },
  },
];

const title = (tableName: string) => tableName.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const short = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 10).map(short);
  return v;
};
const FILE_TYPES = new Set(["file", "files", "image", "images"]);

async function searchRecords(user: CurrentUser, input: z.infer<typeof SearchInput>) {
  const schema = await getSchema(input.table);
  if (!schema || !can(user, schema, "view")) throw new HttpError(404, `There's no table "${input.table}" you can see. Use a key from the list of tables.`);
  const limit = input.limit ?? 10;
  const filters = (input.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.values ?? f.value, value2: f.value2 }));
  const { data, total, totalIsEstimate } = await listForUser(user, schema, {
    search: input.search,
    filters,
    sort: input.sort,
    order: input.order,
    page: 1,
    limit,
  });
  const display = pickDisplayField(schema);
  const files = new Set(schema.columns.filter((c) => FILE_TYPES.has(valueType(c))).map((c) => c.name));
  const records = data.map((row) => {
    const id = String(row._id);
    const out: Record<string, unknown> = {
      _id: id,
      title: String((display === "_id" ? id : row[display]) || id),
      link: `/table/${schema.tableName}/${id}`,
    };
    for (const [k, v] of Object.entries(row)) {
      if (k === "_id" || k === "_createdById" || k === "_departmentId" || k === "_departmentIds" || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
      out[k] = files.has(k) ? "(file attached)" : short(v);
    }
    return out;
  });
  return { total, totalIsEstimate, shown: records.length, records };
}

async function runTool(user: CurrentUser, name: string, raw: unknown): Promise<{ text: string; isError: boolean }> {
  try {
    if (name === "search_records") {
      const input = SearchInput.safeParse(raw);
      if (!input.success) return { text: `Invalid input: ${input.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
      const result = await searchRecords(user, input.data);
      return { text: JSON.stringify(result), isError: false };
    }
    if (name === "find_people") {
      const input = PeopleInput.safeParse(raw);
      if (!input.success) return { text: "Give a name to look for", isError: true };
      const people = await searchUserOptions(input.data.name, 10);
      return { text: JSON.stringify(people.map((p) => ({ id: p.value, name: p.label, username: p.username }))), isError: false };
    }
    return { text: `Unknown tool ${name}`, isError: true };
  } catch (error) {
    // a filter that doesn't fit the column etc.: the AI reads why and tries again
    if (error instanceof HttpError) return { text: error.message, isError: true };
    logger.error({ err: String(error), tool: name }, "Ask Zenin tool failed");
    return { text: "That search failed. Try a simpler one.", isError: true };
  }
}

/* ---------------- what the AI is told ---------------- */

const OPS: Record<string, string> = {
  text: "contains, notContains, eq, neq, isEmpty, isNotEmpty",
  number: "eq, neq, gt, gte, lt, lte, between, isEmpty, isNotEmpty",
  date: "eq, before, after, between, isEmpty, isNotEmpty",
  boolean: "isTrue, isFalse, isEmpty",
  choice: "in, notIn (values: option labels), isEmpty, isNotEmpty",
  user: 'in (values: person ids from find_people, or ["$me"] for the person asking), isEmpty, isNotEmpty',
  relation: "in (values: record _ids from the linked table, found with search_records), isEmpty, isNotEmpty",
  department: 'in (values: department ids, or ["$mine"]), isEmpty, isNotEmpty',
  file: "isEmpty, isNotEmpty",
};

function describeColumn(c: Column) {
  const type = valueType(c);
  const label = c.label && c.label !== c.name ? ` "${c.label}"` : "";
  const extra =
    type === "choice" && c.options?.length
      ? ` options: ${c.options.map((o) => o.label).join(" | ")}`
      : type === "relation" && c.ref
        ? ` → ${c.ref}`
        : "";
  return `${c.name}${label} (${FILE_TYPES.has(type) ? "file" : type})${extra}`;
}

async function instructions(user: CurrentUser) {
  const tables = (await getAllSchemas()).filter((s: TableSchema) => can(user, s, "view")).sort((a, b) => a.tableName.localeCompare(b.tableName));
  const today = new Date().toISOString().slice(0, 10);
  const lines = tables.map((t) => `- ${t.tableName} (${title(t.tableName)}): ${t.columns.map(describeColumn).join("; ")}`);
  return `You are Ask Zenin, the assistant inside ${await brandName()}, an ERP. You answer questions about the organization's records for ${user.fullName || user.username}${
    user.departments.length ? ` (${user.departments.map((d) => d.name).join(", ")})` : ""
  }. Today is ${today}.

How to work:
- Look things up with the tools before answering; never guess or invent records, names or numbers. If the tools don't show it, say you couldn't find it.
- You can only read. If asked to add, change or delete something, say you can't do that yet and link to where they can do it themselves, e.g. [New task](/table/tasks/new).
- You see only what ${user.fullName || "this person"} may see. Don't speculate about other records.
- Prefer one precise search (with filters) over many broad ones. For "how many", use \`total\` from search_records.
- When results are cut off (total is more than shown), say how many there are in all and show the most relevant.

How to answer:
- Short and plain, for an office worker. Start with the answer.
- Link every record you mention: [its title](its link), using the link from the tool result.
- Use "- " lists for several items, **bold** sparingly. No tables, no headings, no code.

Filter operators by column type: ${Object.entries(OPS)
    .map(([k, v]) => `${k}: ${v}`)
    .join(". ")}. Dates are YYYY-MM-DD, or $today, $today+7, $today-30. "_createdBy" (who added the record) filters like a user column; "_department" like a department column.

The tables ${user.fullName || "this person"} can see (key (Title): column key "Label" (type)):
${lines.length ? lines.join("\n") : "(none)"}`;
}

/* ---------------- the three providers ---------------- */

type Run = { user: CurrentUser; system: string; turns: Turn[]; ai: Ai; meter: Meter };

const outOfRounds = "I couldn't finish looking that up. Try a more specific question.";

async function chatClaude({ user, system, turns, ai, meter }: Run): Promise<string> {
  const client = new Anthropic({ apiKey: ai.key, authToken: null, timeout: TIMEOUT_MS });
  const tools: Anthropic.Beta.Messages.BetaTool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
  }));
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.beta.messages.create({
        model: ai.model,
        max_tokens: 16000,
        // a declined request is re-run on Anthropic's recommended fallback model
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // a chat: quick answers; the instructions and tables are cached across rounds
        output_config: { effort: "low" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      });
      const u = response.usage;
      meter.cacheRead += u.cache_read_input_tokens ?? 0;
      meter.cacheWrite += u.cache_creation_input_tokens ?? 0;
      meter.input += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      meter.output += u.output_tokens;

      if (response.stop_reason === "refusal") throw refused(ai);
      const uses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !uses.length) {
        if (response.stop_reason === "max_tokens") throw new HttpError(502, "The answer came back incomplete. Try a narrower question.");
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
        return text || outOfRounds;
      }
      // the whole answer goes back as it came (thinking included)
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const r = await runTool(user, use.name, use.input);
        results.push({ type: "tool_result", tool_use_id: use.id, content: r.text, is_error: r.isError });
      }
      messages.push({ role: "user", content: results });
    }
    return outOfRounds;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Anthropic.APIConnectionError) throw new HttpError(502, "Couldn't reach Claude. Check the server's internet connection and try again.");
    if (error instanceof Anthropic.APIError) throw failed(ai, error.status ?? 502, error.message);
    throw error;
  }
}

type GeminiPart = { text?: string; thought?: boolean; functionCall?: { id?: string; name: string; args?: unknown }; [k: string]: unknown };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

async function chatGemini({ user, system, turns, ai, meter }: Run): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`;
  const contents: GeminiContent[] = turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] }));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = (await post(
      ai,
      url,
      { "x-goog-api-key": ai.key },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: TOOLS }],
      }
    )) as {
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      promptFeedback?: { blockReason?: string };
      candidates?: { finishReason?: string; content?: GeminiContent }[];
    };
    meter.input += data.usageMetadata?.promptTokenCount ?? 0;
    meter.output += (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0);
    const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || !candidate?.content) throw refused(ai);
    const parts = candidate.content.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      if (candidate.finishReason === "MAX_TOKENS") throw new HttpError(502, "The answer came back incomplete. Try a narrower question.");
      if (candidate.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) throw refused(ai);
      return parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("").trim() || outOfRounds;
    }
    // the model's turn goes back exactly as it came (its thought signatures with it)
    contents.push({ role: "model", parts });
    const responses: GeminiPart[] = [];
    for (const call of calls) {
      const fc = call.functionCall!;
      const r = await runTool(user, fc.name, fc.args ?? {});
      responses.push({
        functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: r.isError ? { error: r.text } : { result: JSON.parse(r.text) } },
      });
    }
    contents.push({ role: "user", parts: responses });
  }
  return outOfRounds;
}

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

async function chatChatGpt({ user, system, turns, ai, meter }: Run): Promise<string> {
  const messages: OpenAiMessage[] = [{ role: "system", content: system }, ...turns.map((t) => ({ role: t.role, content: t.content }) as OpenAiMessage)];
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = (await post(ai, "https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${ai.key}` }, { model: ai.model, messages, tools })) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: {
        finish_reason?: string;
        message?: { content?: string | null; refusal?: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
      }[];
    };
    meter.input += data.usage?.prompt_tokens ?? 0;
    meter.output += data.usage?.completion_tokens ?? 0;
    const choice = data.choices?.[0];
    if (!choice?.message || choice.message.refusal) throw refused(ai);
    const calls = choice.message.tool_calls ?? [];
    if (!calls.length) {
      if (choice.finish_reason === "length") throw new HttpError(502, "The answer came back incomplete. Try a narrower question.");
      return (choice.message.content ?? "").trim() || outOfRounds;
    }
    messages.push({ role: "assistant", content: choice.message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // runTool reports the missing fields
      }
      const r = await runTool(user, call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: r.isError ? `Error: ${r.text}` : r.text });
    }
  }
  return outOfRounds;
}

/* ---------------- the question ---------------- */

// The last turns of the conversation (from the browser), cleaned up: text
// only, alternating, ending with the new question.
export function cleanTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, "Ask a question");
  const turns = raw
    .slice(-MAX_TURNS)
    .filter((t): t is Turn => Boolean(t) && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim() !== "")
    .map((t) => ({ role: t.role, content: t.content.slice(0, t.role === "user" ? 2000 : 6000) }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  const merged: Turn[] = [];
  for (const t of turns) {
    const last = merged.at(-1);
    if (last?.role === t.role) last.content += `\n\n${t.content}`;
    else merged.push({ ...t });
  }
  if (!merged.length || merged.at(-1)!.role !== "user") throw new HttpError(400, "Ask a question");
  return merged;
}

export async function ask(user: CurrentUser, rawTurns: unknown): Promise<{ answer: string }> {
  if (!(await canAsk(user))) throw new HttpError(403, "Ask Zenin isn't switched on for you.");
  const turns = cleanTurns(rawTurns);
  const ai = await activeAi();
  if (!ai) throw new HttpError(503, "AI features aren't set up.");
  const who = { _id: user._id, isAdmin: isAdmin(user) };
  await checkLimits(who);
  const system = await instructions(user);
  const answer = await metered(ai, "askZenin", who, (meter) => {
    const run = { user, system, turns, ai, meter };
    return ai.provider === "anthropic" ? chatClaude(run) : ai.provider === "gemini" ? chatGemini(run) : chatChatGpt(run);
  });
  return { answer };
}
