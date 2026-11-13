import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { memoryMailbox } from "../src/mail/mailer.js";
import { processOutbox } from "../src/mail/outbox.js";
import { getApp, login, unique } from "./helpers.js";

// The organization's name and logo (Administration → Branding), and people's
// profile pictures.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("Branding and profile pictures", async () => {
  const app = await getApp();
  const anonymous = request(app);
  const admin = await login();
  const role = (await admin.post("/api/roles", { name: unique("Plain"), permissions: {} })).body.role;
  const username = unique("pia").toLowerCase();
  await admin.post("/api/users", { username, fullName: "Pia Lund", email: `${username}@example.com`, password: "pass-123-pass", roleId: role._id }).expect(201);
  const pia = await login(username, "pass-123-pass");
  const upload = async (who: typeof admin, name: string, body = PNG) => (await who.upload("/api/upload").attach("files", body, name).expect(200)).body[0].url as string;

  afterAll(async () => {
    await admin.put("/api/branding", { name: "Zenin ERP", logoUrl: "" });
  });

  it("starts as Zenin ERP with a letter mark, visible before signing in", async () => {
    expect((await anonymous.get("/api/branding").expect(200)).body).toEqual({ name: "Zenin ERP", logoVersion: null });
    expect((await anonymous.get("/api/branding/logo")).status).toBe(404);
  });

  it("an admin names it and gives it a logo", async () => {
    expect((await pia.put("/api/branding", { name: "Pia's ERP" })).status).toBe(403);
    expect((await admin.put("/api/branding", { name: "  " })).status).toBe(400);
    expect((await admin.put("/api/branding", { name: "x".repeat(41) })).status).toBe(400);
    expect((await admin.put("/api/branding", { logoUrl: "https://example.com/logo.png" })).status).toBe(400);
    const notImage = await upload(admin, "notes.txt", Buffer.from("hello"));
    expect((await admin.put("/api/branding", { logoUrl: notImage })).status).toBe(400);

    const logo = await upload(admin, "logo.png");
    const saved = (await admin.put("/api/branding", { name: "Acme   Works", logoUrl: logo }).expect(200)).body.branding;
    expect(saved).toMatchObject({ name: "Acme Works", logoVersion: expect.stringMatching(/^[0-9a-f]{10}$/) });
    expect((await anonymous.get("/api/branding")).body).toEqual(saved);

    // the logo itself, also before signing in, cached for long (its URL changes with it)
    const res = await anonymous.get("/api/branding/logo").expect(200);
    expect(res.headers["content-type"]).toMatch(/^image\/png/);
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
    // ...while other uploads still need a sign-in
    expect((await anonymous.get(logo)).status).toBe(401);
  });

  it("emails use the name", async () => {
    await admin.put("/api/email", { provider: "gmail", user: "office@example.com", pass: "x".repeat(16), appUrl: "http://erp.local" }).expect(200);
    await processOutbox();
    const before = memoryMailbox.length;
    await anonymous.post("/api/auth/forgot").set("X-Requested-With", "XMLHttpRequest").send({ login: username }).expect(200);
    await processOutbox();
    const mail = memoryMailbox.slice(before).find((m) => m.to === `${username}@example.com`);
    expect(mail?.subject).toBe("Reset your Acme Works password");
    expect(mail?.text).toContain("your Acme Works password");
  });

  it("removing the logo goes back to the letter mark", async () => {
    await admin.put("/api/branding", { logoUrl: "" }).expect(200);
    expect((await anonymous.get("/api/branding")).body).toEqual({ name: "Acme Works", logoVersion: null });
  });

  it("everyone can set their own profile picture", async () => {
    expect((await pia.get("/api/auth/me")).body.user.avatarUrl).toBe("");
    expect((await pia.put("/api/auth/profile", { avatarUrl: "/uploads/../secret.png" })).status).toBe(400);
    expect((await pia.put("/api/auth/profile", { avatarUrl: "javascript:alert(1)" })).status).toBe(400);
    const picture = await upload(pia, "me.jpg");
    await pia.put("/api/auth/profile", { avatarUrl: picture }).expect(200);
    expect((await pia.get("/api/auth/me")).body.user.avatarUrl).toBe(picture);
    // and back to initials
    await pia.put("/api/auth/profile", { avatarUrl: "" }).expect(200);
    expect((await pia.get("/api/auth/me")).body.user.avatarUrl).toBe("");
  });
});
