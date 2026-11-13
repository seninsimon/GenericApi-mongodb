// Standard prices in US dollars per million tokens, for the estimates in
// Administration → AI (checked on the providers' pricing pages, 2026-11-13).
// Thinking/reasoning tokens are billed as output. The provider's bill is the
// truth: discounts, free tiers and taxes aren't known here.

type Price = { input: number; output: number; from?: string }; // from: YYYY-MM-DD, a later price

const PRICES: Record<string, Price[]> = {
  // Claude
  "claude-opus-5-5": [{ input: 4, output: 20 }],
  "claude-sonnet-5-5": [{ input: 2, output: 10 }],
  "claude-haiku-5-5": [{ input: 0.1, output: 0.5 }],
  // Gemini
  "gemini-4-hydrogen": [{ input: 1.5, output: 7.5 }],
  "gemini-3.8-flash": [
    { input: 0.75, output: 3.75 },
    { input: 1.5, output: 7.5, from: "2027-01-01" },
  ],
  "gemini-3.5-flash-lite": [{ input: 0.3, output: 2.5 }],
  // ChatGPT
  "gpt-6.1-sol": [{ input: 2, output: 10 }],
  "gpt-6-astra": [{ input: 10, output: 50 }],
  "gpt-6-luna": [{ input: 0.1, output: 0.5 }],
};

// The estimated cost of one request, or null when the model's price isn't known.
// `cache` (Claude): of the input tokens, those written to the prompt cache
// (1.25× the input price) and read from it (0.1×).
export function estimateCost(model: string, inputTokens: number, outputTokens: number, cache = { read: 0, write: 0 }, at = new Date()): number | null {
  const list = PRICES[model];
  if (!list) return null;
  const day = at.toISOString().slice(0, 10);
  const price = [...list].reverse().find((p) => !p.from || p.from <= day) ?? list[0];
  const plain = Math.max(0, inputTokens - cache.read - cache.write);
  return ((plain + cache.write * 1.25 + cache.read * 0.1) * price.input + outputTokens * price.output) / 1_000_000;
}

export const knownPrice = (model: string) => model in PRICES;
