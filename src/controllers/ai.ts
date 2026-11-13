import type { Request, Response } from "express";
import { testAi } from "../ai/generate.js";
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
      key: body.removeKey === true ? "removed" : typeof body.key === "string" && body.key.trim() ? (before.keys[saved.provider] ? "replaced" : "added") : "unchanged",
    },
  });
  res.json({ message: "AI settings saved", settings: publicAiSettings(saved) });
}

// POST /ai/test: one tiny request with the saved key
export async function testAiHandler(_req: Request, res: Response) {
  const { provider, model } = await testAi();
  res.json({ message: `${PROVIDER_NAMES[provider]} is working (${model})` });
}
