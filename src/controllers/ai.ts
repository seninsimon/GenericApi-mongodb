import type { Request, Response } from "express";
import { ask, canAsk } from "../ai/assistant.js";
import { testAi } from "../ai/generate.js";
import { usageOverview } from "../ai/usage.js";
import { isAdmin } from "../auth/access.js";
import { currentUser } from "../middleware/auth.js";
import { getAiSettings, PROVIDER_NAMES, publicAiSettings, saveAiSettings } from "../ai/settings.js";
import { audit } from "../repo/auditRepo.js";

// Administration → AI (admins): which AI drafts apps, and its key.

// GET /ai
export async function getAiHandler(_req: Request, res: Response) {
  res.json(publicAiSettings(await getAiSettings()));
}

// PUT /ai { provider, key?, model?, removeKey? }
export async function saveAiHandler(req: Request, res: Response) {
  const before = await getAiSettings();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const saved = await saveAiSettings(body);
  // never the key itself in the audit log
  await audit(req, {
    action: "settings",
    entity: "ai",
    changes: {
      provider: saved.provider,
      model: saved.model || null,
      ...(body.features ? { features: saved.features } : {}),
      ...(body.limits ? { limits: saved.limits } : {}),
      key: body.removeKey === true ? "removed" : typeof body.key === "string" && body.key.trim() ? (before.keys[saved.provider] ? "replaced" : "added") : "unchanged",
    },
  });
  res.json({ message: "AI settings saved", settings: publicAiSettings(saved) });
}

// POST /ai/test: one tiny request with the saved key
export async function testAiHandler(req: Request, res: Response) {
  const me = currentUser(req);
  const { provider, model } = await testAi({ _id: me._id, isAdmin: isAdmin(me) });
  res.json({ message: `${PROVIDER_NAMES[provider]} is working (${model})` });
}

// GET /ai/usage: this month and last, by feature and by person (estimates)
export async function aiUsageHandler(_req: Request, res: Response) {
  res.json(await usageOverview());
}

// GET /ai/assistant: may this person use Ask Zenin? (shows the Ask button)
export async function assistantHandler(req: Request, res: Response) {
  res.json({ available: await canAsk(currentUser(req)) });
}

// POST /ai/ask { turns: [{ role, content }] }: the answer to the last question
export async function askHandler(req: Request, res: Response) {
  res.json(await ask(currentUser(req), (req.body ?? {}).turns));
}
