import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { activeAi, PROVIDER_NAMES, type Provider } from "./settings.js";

// One question, a JSON answer in a given shape, from whichever AI the admin
// chose (Administration → AI). Every provider gets the same instructions and
// the same JSON Schema; the caller checks the answer again.

type Ask<T extends z.ZodType> = { system: string; prompt: string; schema: T; name: string };
type Ai = { provider: Provider; model: string; key: string };

const TIMEOUT_MS = 180_000;

// The provider's own words, kept short, for the admin and the log.
const reason = (text: string) => {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    if (msg) return msg.slice(0, 300);
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
};

// An HTTP failure, in plain words.
function failed(ai: Ai, status: number, detail: string): HttpError {
  const name = PROVIDER_NAMES[ai.provider];
  logger.error({ provider: ai.provider, model: ai.model, status, detail }, "AI request failed");
  if (status === 401 || status === 403 || (status === 400 && /api key|api_key|unauthori[sz]ed/i.test(detail))) {
    return new HttpError(503, `${name} refused the API key. Check it in Administration → AI.`, { detail });
  }
  if (status === 404 || (/model/i.test(detail) && /not (found|exist|supported)|does not exist|unknown|invalid/i.test(detail))) {
    return new HttpError(503, `${name} doesn't offer the model "${ai.model}" to this key. Clear Advanced → Model in Administration → AI to use our pick.`, {
      detail,
    });
  }
  if (status === 429) {
    return new HttpError(429, `${name} says there are too many requests, or the account is out of credit. Try again later, or check the plan.`, { detail });
  }
  return new HttpError(502, `${name} didn't answer properly. Try again in a minute.`, { detail });
}

async function post(ai: Ai, url: string, headers: Record<string, string>, body: unknown) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    logger.error({ provider: ai.provider, err: String(error) }, "AI request didn't reach the provider");
    throw new HttpError(502, `Couldn't reach ${PROVIDER_NAMES[ai.provider]}. Check the server's internet connection and try again.`);
  }
  const text = await res.text();
  if (!res.ok) throw failed(ai, res.status, reason(text));
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw failed(ai, 502, "the answer wasn't JSON");
  }
}

const refused = (ai: Ai) => new HttpError(422, `${PROVIDER_NAMES[ai.provider]} declined this one. Try describing it differently.`);
const incomplete = () => new HttpError(502, "The AI's answer came back incomplete. Try again, or describe a smaller part.");
const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw incomplete();
  }
};

/* ---------------- the three providers ---------------- */

async function askClaude<T extends z.ZodType>(ai: Ai, ask: Ask<T>, tiny: boolean): Promise<unknown> {
  const client = new Anthropic({ apiKey: ai.key, authToken: null, timeout: TIMEOUT_MS });
  try {
    if (tiny) {
      await client.messages.create({ model: ai.model, max_tokens: 16, messages: [{ role: "user", content: ask.prompt }] });
      return null;
    }
    const response = await client.beta.messages.parse({
      model: ai.model,
      max_tokens: 16000,
      // a declined request is re-run on Anthropic's recommended fallback model
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(ask.schema) },
      system: ask.system,
      messages: [{ role: "user", content: ask.prompt }],
    });
    if (response.stop_reason === "refusal") throw refused(ai);
    if (response.stop_reason === "max_tokens" || !response.parsed_output) throw incomplete();
    return response.parsed_output;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Anthropic.APIConnectionError) throw new HttpError(502, "Couldn't reach Claude. Check the server's internet connection and try again.");
    if (error instanceof Anthropic.APIError) throw failed(ai, error.status ?? 502, error.message);
    throw error;
  }
}

async function askGemini<T extends z.ZodType>(ai: Ai, ask: Ask<T>, schema: object, tiny: boolean): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`;
  const body = tiny
    ? { contents: [{ role: "user", parts: [{ text: ask.prompt }] }] }
    : {
        systemInstruction: { parts: [{ text: ask.system }] },
        contents: [{ role: "user", parts: [{ text: ask.prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 32000 },
      };
  const data = (await post(ai, url, { "x-goog-api-key": ai.key }, body)) as {
    promptFeedback?: { blockReason?: string };
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  if (tiny) return null;
  if (data.promptFeedback?.blockReason) throw refused(ai);
  const candidate = data.candidates?.[0];
  if (!candidate) throw refused(ai);
  if (candidate.finishReason === "MAX_TOKENS") throw incomplete();
  if (candidate.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) throw refused(ai);
  const text = (candidate.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  return parseJson(text);
}

async function askChatGpt<T extends z.ZodType>(ai: Ai, ask: Ask<T>, schema: object, tiny: boolean): Promise<unknown> {
  const body = tiny
    ? { model: ai.model, messages: [{ role: "user", content: ask.prompt }], max_completion_tokens: 64 }
    : {
        model: ai.model,
        messages: [
          { role: "system", content: ask.system },
          { role: "user", content: ask.prompt },
        ],
        response_format: { type: "json_schema", json_schema: { name: ask.name, schema, strict: true } },
        max_completion_tokens: 32000,
      };
  const data = (await post(ai, "https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${ai.key}` }, body)) as {
    choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  };
  if (tiny) return null;
  const choice = data.choices?.[0];
  if (!choice || choice.message?.refusal) throw refused(ai);
  if (choice.finish_reason === "length") throw incomplete();
  return parseJson(choice.message?.content ?? "");
}

/* ---------------- what the app calls ---------------- */

const notSetUp = () => new HttpError(503, "Drafting with AI isn't set up. An admin can add an AI key in Administration → AI.");

// The chosen AI's answer, checked against the schema.
export async function generateJson<T extends z.ZodType>(ask: Ask<T>): Promise<z.infer<T>> {
  const ai = await activeAi();
  if (!ai) throw notSetUp();
  const { $schema: _ignored, ...schema } = z.toJSONSchema(ask.schema) as Record<string, unknown>;
  const raw =
    ai.provider === "anthropic"
      ? await askClaude(ai, ask, false)
      : ai.provider === "gemini"
        ? await askGemini(ai, ask, schema, false)
        : await askChatGpt(ai, ask, schema, false);
  const parsed = ask.schema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ provider: ai.provider, model: ai.model, issues: parsed.error.issues.slice(0, 5) }, "AI answer not in the expected shape");
    throw new HttpError(502, "The AI's answer wasn't in the expected shape. Try again.");
  }
  return parsed.data;
}

// Administration → AI → Test: one tiny request with the saved key and model.
export async function testAi(): Promise<{ provider: Provider; model: string }> {
  const ai = await activeAi();
  if (!ai) throw new HttpError(400, "Paste an API key first");
  const ask = { system: "", prompt: "Reply with the word OK.", schema: z.object({}), name: "test" };
  if (ai.provider === "anthropic") await askClaude(ai, ask, true);
  else if (ai.provider === "gemini") await askGemini(ai, ask, {}, true);
  else await askChatGpt(ai, ask, {}, true);
  return { provider: ai.provider, model: ai.model };
}
