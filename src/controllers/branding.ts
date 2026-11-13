import type { Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import { getBranding, publicBranding, saveBranding } from "../branding.js";
import { HttpError } from "../lib/http.js";
import { audit } from "../repo/auditRepo.js";
import { ObjectNotFoundError, storage, uploadKeyFromUrl } from "../storage.js";

// GET /branding (no sign-in needed: the sign-in page shows them)
export async function getBrandingHandler(_req: Request, res: Response) {
  res.json(publicBranding(await getBranding()));
}

// GET /branding/logo (no sign-in needed). Cached for long: the URL carries
// ?v=<version>, which changes with the logo.
export async function logoHandler(_req: Request, res: Response) {
  const key = uploadKeyFromUrl((await getBranding()).logoUrl);
  if (!key) throw new HttpError(404, "No logo");
  try {
    const object = await storage.get(key);
    res.set({
      "Content-Type": object.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // an SVG logo never runs scripts
      "Content-Security-Policy": "sandbox",
    });
    if (object.contentLength != null) res.set("Content-Length", String(object.contentLength));
    await pipeline(object.body, res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw new HttpError(404, "No logo");
    throw error;
  }
}

// PUT /branding { name?, logoUrl? } (admin; logoUrl "" removes the logo)
export async function saveBrandingHandler(req: Request, res: Response) {
  const { before, after } = await saveBranding((req.body ?? {}) as Record<string, unknown>);
  // the old logo file stays in storage (the address could be any upload)
  await audit(req, {
    action: "settings",
    entity: "branding",
    changes: { ...(before.name !== after.name ? { name: after.name } : {}), ...(before.logoUrl !== after.logoUrl ? { logo: after.logoUrl ? "changed" : "removed" } : {}) },
  });
  res.json({ message: "Saved", branding: publicBranding(after) });
}
