import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { activeAi, getAiSettings, PROVIDER_NAMES, type Feature, type Provider } from "./settings.js";
import { checkLimits, recordUsage, type Who } from "./usage.js";

// One question, a JSON answer in a given shape, from whichever AI the admin
// chose (Administration → AI). Every provider gets the same instructions and
// the same JSON Schema; the answer is checked again here. Every request is
// counted (tokens, estimated cost) and the limits are checked first.

type Ask<T extends z.ZodType> = { system: string; prompt: string; schema: T; name: string };
export type Ai = { provider: Provider; model: string; key: string };
// tokens the provider reports, filled in as soon as an answer arrives (billed
// even when it's refused); added up over the rounds of a conversation
export type Meter = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const TIMEOUT_MS = 180_000;

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
export function failed(ai: Ai, status: number, detail: string): HttpError {
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

export async function post(ai: Ai, url: string, headers: Record<string, string>, body: unknown) {
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

export const refused = (ai: Ai) => new HttpError(422, `${PROVIDER_NAMES[ai.provider]} declined this one. Try describing it differently.`);
const incomplete = () => new HttpError(502, "The AI's answer came back incomplete. Try again, or describe a smaller part.");
const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw incomplete();
  }
};

/* ---------------- the three providers ---------------- */

async function askClaude<T extends z.ZodType>(ai: Ai, ask: Ask<T>, meter: Meter, tiny: boolean): Promise<unknown> {
  const client = new Anthropic({ apiKey: ai.key, authToken: null, timeout: TIMEOUT_MS });
  try {
    if (tiny) {
      const r = await client.messages.create({ model: ai.model, max_tokens: 16, messages: [{ role: "user", content: ask.prompt }] });
      meter.input = r.usage.input_tokens;
      meter.output = r.usage.output_tokens;
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
    meter.input = response.usage.input_tokens;
    meter.output = response.usage.output_tokens;
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

async function askGemini<T extends z.ZodType>(ai: Ai, ask: Ask<T>, schema: object, meter: Meter, tiny: boolean): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`;
  const body = tiny
    ? { contents: [{ role: "user", parts: [{ text: ask.prompt }] }] }
    : {
        systemInstruction: { parts: [{ text: ask.system }] },
        contents: [{ role: "user", parts: [{ text: ask.prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 32000 },
      };
  const data = (await post(ai, url, { "x-goog-api-key": ai.key }, body)) as {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    promptFeedback?: { blockReason?: string };
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  // thinking is billed as output
  meter.input = data.usageMetadata?.promptTokenCount ?? 0;
  meter.output = (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0);
  if (tiny) return null;
  if (data.promptFeedback?.blockReason) throw refused(ai);
  const candidate = data.candidates?.[0];
  if (!candidate) throw refused(ai);
  if (candidate.finishReason === "MAX_TOKENS") throw incomplete();
  if (candidate.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) throw refused(ai);
  const text = (candidate.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  return parseJson(text);
}

async function askChatGpt<T extends z.ZodType>(ai: Ai, ask: Ask<T>, schema: object, meter: Meter, tiny: boolean): Promise<unknown> {
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
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  };
  // reasoning is part of completion_tokens
  meter.input = data.usage?.prompt_tokens ?? 0;
  meter.output = data.usage?.completion_tokens ?? 0;
  if (tiny) return null;
  const choice = data.choices?.[0];
  if (!choice || choice.message?.refusal) throw refused(ai);
  if (choice.finish_reason === "length") throw incomplete();
  return parseJson(choice.message?.content ?? "");
}

/* ---------------- what the app calls ---------------- */

const notSetUp = () => new HttpError(503, "AI features aren't set up. An admin can add an AI key in Administration → AI.");

// Count the request, whatever happens.
export async function metered<R>(ai: Ai, feature: string, who: Who, run: (meter: Meter) => Promise<R>): Promise<R> {
  const meter: Meter = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let ok = false;
  try {
    const result = await run(meter);
    ok = true;
    return result;
  } finally {
    await recordUsage({
      feature,
      who,
      provider: ai.provider,
      model: ai.model,
      inputTokens: meter.input,
      outputTokens: meter.output,
      ok,
      cache: { read: meter.cacheRead, write: meter.cacheWrite },
    });
  }
}

// The chosen AI's answer for a feature, checked against the schema.
export async function generateJson<T extends z.ZodType>(feature: Feature, who: Who, ask: Ask<T>): Promise<z.infer<T>> {
  const ai = await activeAi();
  if (!ai) throw notSetUp();
  if (!(await getAiSettings()).features[feature]) throw new HttpError(403, "This AI feature is switched off in Administration → AI.");
  await checkLimits(who);
  const { $schema: _ignored, ...schema } = z.toJSONSchema(ask.schema) as Record<string, unknown>;
  return metered(ai, feature, who, async (meter) => {
    const raw =
      ai.provider === "anthropic"
        ? await askClaude(ai, ask, meter, false)
        : ai.provider === "gemini"
          ? await askGemini(ai, ask, schema, meter, false)
          : await askChatGpt(ai, ask, schema, meter, false);
    const parsed = ask.schema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ provider: ai.provider, model: ai.model, issues: parsed.error.issues.slice(0, 5) }, "AI answer not in the expected shape");
      throw new HttpError(502, "The AI's answer wasn't in the expected shape. Try again.");
    }
    return parsed.data;
  });
}

// Administration → AI → Test: one tiny request with the saved key and model.
// It ignores the switches and limits (it's how an admin checks the setup).
export async function testAi(who: Who): Promise<{ provider: Provider; model: string }> {
  const ai = await activeAi();
  if (!ai) throw new HttpError(400, "Paste an API key first");
  const ask = { system: "", prompt: "Reply with the word OK.", schema: z.object({}), name: "test" };
  await metered(ai, "test", who, async (meter) => {
    if (ai.provider === "anthropic") await askClaude(ai, ask, meter, true);
    else if (ai.provider === "gemini") await askGemini(ai, ask, {}, meter, true);
    else await askChatGpt(ai, ask, {}, meter, true);
  });
  return { provider: ai.provider, model: ai.model };
}
