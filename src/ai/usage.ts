import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { notify } from "../schema/automations.js";
import { estimateCost } from "./prices.js";
import { getAiSettings, type Provider } from "./settings.js";

// Usage of the AI features: one ai_usage row per request (never what was
// asked), the limits checked before a request, and a bell for the admins at
// 80% of the monthly limit. workspace/AI_FEATURES_PLAN.md

export type Who = { _id: string; isAdmin: boolean } | null; // null: the system

const THIS_MONTH = `created_at >= date_trunc('month', now())`;

async function thisMonthSpend() {
  const { rows } = await query<{ usd: string | null }>(`SELECT sum(cost_usd) AS usd FROM ai_usage WHERE ${THIS_MONTH}`);
  return Number(rows[0]?.usd ?? 0);
}

// Before a request: stop it when a limit is reached.
export async function checkLimits(who: Who) {
  const { limits } = await getAiSettings();
  if (limits.monthlyUsd !== null && (await thisMonthSpend()) >= limits.monthlyUsd) {
    throw new HttpError(429, "This month's AI limit is reached. An admin can raise it in Administration → AI.");
  }
  if (limits.perPersonDaily !== null && who && !who.isAdmin) {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_usage WHERE user_id = $1 AND feature <> 'test' AND created_at >= date_trunc('day', now())`,
      [who._id]
    );
    if (rows[0].n >= limits.perPersonDaily) throw new HttpError(429, "You've reached today's limit for AI features. Try again tomorrow.");
  }
}

export type UsageRecord = {
  feature: string;
  who: Who;
  provider: Provider;
  model: string;
  inputTokens: number; // all of them, cached ones included
  outputTokens: number;
  ok: boolean;
  cache?: { read: number; write: number };
};

// After a request (worked or not): one row, then the 80% warning once a month.
export async function recordUsage(r: UsageRecord) {
  try {
    await query(
      `INSERT INTO ai_usage (feature, user_id, provider, model, input_tokens, output_tokens, ok, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.feature, r.who?._id ?? null, r.provider, r.model, r.inputTokens, r.outputTokens, r.ok, estimateCost(r.model, r.inputTokens, r.outputTokens, r.cache)]
    );
    await warnNearLimit();
  } catch (error) {
    // the answer matters more than the count
    logger.error({ err: String(error) }, "couldn't record AI usage");
  }
}

async function warnNearLimit() {
  const { limits } = await getAiSettings();
  const limit = limits.monthlyUsd;
  if (limit === null) return;
  const spent = await thisMonthSpend();
  if (spent < limit * 0.8) return;
  const reached = spent >= limit;
  // once per month and level: claimed atomically, so two requests don't both warn
  const level = `${new Date().toISOString().slice(0, 7)}:${reached ? "100" : "80"}`;
  const { rowCount } = await query(
    `INSERT INTO app_state (key, value) VALUES ('ai_limit_warned', jsonb_build_object('level', $1::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     WHERE app_state.value->>'level' IS DISTINCT FROM $1::text`,
    [level]
  );
  if (!rowCount) return;
  const { rows } = await query<{ _id: string }>(`SELECT u._id FROM users u JOIN roles r ON r._id = u.role_id WHERE r.is_admin AND u.is_active`);
  await withTransaction((client) =>
    notify(
      client,
      rows.map((u) => u._id),
      {
        title: reached ? "AI features paused: this month's limit is reached" : "AI spending is at 80% of this month's limit",
        body: `About $${spent.toFixed(2)} of $${limit.toFixed(2)} so far. See Administration → AI.`,
      },
      { email: false }
    )
  );
}

type TotalsRow = { requests: number; failed: number; input_tokens: string; output_tokens: string; usd: string | null; unpriced: number };

async function totals(where: string) {
  const { rows } = await query<TotalsRow>(
    `SELECT count(*)::int AS requests, count(*) FILTER (WHERE NOT ok)::int AS failed,
            coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(output_tokens), 0) AS output_tokens,
            sum(cost_usd) AS usd, count(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced
       FROM ai_usage WHERE ${where}`
  );
  const t = rows[0];
  return {
    requests: t.requests,
    failed: t.failed,
    inputTokens: Number(t.input_tokens),
    outputTokens: Number(t.output_tokens),
    costUsd: Number(t.usd ?? 0),
    unpriced: t.unpriced, // requests on a model whose price isn't known
  };
}

// Administration → AI → Usage
export async function usageOverview() {
  const [month, lastMonth, byFeature, byPerson] = await Promise.all([
    totals(THIS_MONTH),
    totals(`created_at >= date_trunc('month', now()) - interval '1 month' AND created_at < date_trunc('month', now())`),
    query<{ feature: string; requests: number; usd: string | null }>(
      `SELECT feature, count(*)::int AS requests, sum(cost_usd) AS usd FROM ai_usage
        WHERE ${THIS_MONTH} GROUP BY feature ORDER BY sum(cost_usd) DESC NULLS LAST, count(*) DESC`
    ),
    query<{ user_id: string | null; name: string | null; requests: number; usd: string | null }>(
      `SELECT a.user_id, coalesce(nullif(u.full_name, ''), u.username) AS name, count(*)::int AS requests, sum(a.cost_usd) AS usd
         FROM ai_usage a LEFT JOIN users u ON u._id = a.user_id
        WHERE a.${THIS_MONTH} GROUP BY a.user_id, u.full_name, u.username
        ORDER BY sum(a.cost_usd) DESC NULLS LAST, count(*) DESC LIMIT 10`
    ),
  ]);
  return {
    month,
    lastMonth,
    byFeature: byFeature.rows.map((r) => ({ feature: r.feature, requests: r.requests, costUsd: Number(r.usd ?? 0) })),
    byPerson: byPerson.rows.map((r) => ({ userId: r.user_id, name: r.name ?? "Removed person", requests: r.requests, costUsd: Number(r.usd ?? 0) })),
  };
}
