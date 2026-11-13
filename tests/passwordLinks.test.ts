import { describe, expect, it } from "vitest";
import { query } from "../src/db/pool.js";
import { memoryMailbox } from "../src/mail/mailer.js";
import { processOutbox } from "../src/mail/outbox.js";
import { anonymous, login, unique } from "./helpers.js";

// Welcome emails and "Forgot password?" (tests use an in-memory mailbox)
describe("Password links by email", async () => {
  const admin = await login();
  await admin.put("/api/email", { provider: "gmail", user: "office@example.com", pass: "x".repeat(16), appUrl: "http://erp.local" }).expect(200);
  const member = (await admin.get("/api/roles")).body.find((r: { name: string }) => r.name === "Member")._id;
  const tokenFrom = async (to: string) => {
    await processOutbox();
    const mail = memoryMailbox.filter((m) => m.to === to).at(-1);
    return { mail, token: mail ? /set-password\?token=([\w-]+)/.exec(mail.text)?.[1] : undefined };
  };
  const guest = await anonymous();

  it("Add person can email a welcome link instead of a password", async () => {
    const username = unique("neha").toLowerCase();
    const email = `${username}@example.com`;
    expect((await admin.post("/api/users", { username, roleId: member, sendInvite: true })).status).toBe(400); // no address
    const res = await admin.post("/api/users", { username, fullName: "Neha Rao", email, roleId: member, sendInvite: true }).expect(201);
    expect(res.body.invited).toBe(true);
    const { mail, token } = await tokenFrom(email);
    expect(mail!.subject).toBe("Welcome to Zenin ERP: set your password");
    expect(mail!.text).toContain(`Your username: ${username}`);

    expect((await guest.get(`/api/auth/password-link?token=${token}`).expect(200)).body).toMatchObject({ username, fullName: "Neha Rao", purpose: "invite" });
    expect((await guest.post("/api/auth/set-password", { token, password: "short" })).status).toBe(400);
    await guest.post("/api/auth/set-password", { token, password: "neha-chose-this-1" }).expect(200);
    await login(username, "neha-chose-this-1"); // she can sign in
    // a link works once
    expect((await guest.post("/api/auth/set-password", { token, password: "again-and-again-1" })).status).toBe(400);
    // and once sent, the email's link isn't kept in the outbox
    const { rows } = await query<{ text_body: string }>(`SELECT text_body FROM email_outbox WHERE to_address = $1 AND kind = 'account'`, [email]);
    expect(rows.every((r) => r.text_body === "")).toBe(true);
  });

  it('"Forgot password?" by username or email; the answer never tells whether an account exists', async () => {
    const username = unique("omar").toLowerCase();
    const email = `${username}@example.com`;
    await admin.post("/api/users", { username, email, password: "old-password-1", roleId: member }).expect(201);
    const unknown = await guest.post("/api/auth/forgot", { login: "nobody-here" }).expect(200);
    const known = await guest.post("/api/auth/forgot", { login: email.toUpperCase() }).expect(200);
    expect(known.body.message).toBe(unknown.body.message);

    const { mail, token } = await tokenFrom(email);
    expect(mail!.subject).toBe("Reset your Zenin ERP password");
    await guest.post("/api/auth/set-password", { token, password: "new-password-1" }).expect(200);
    await login(username, "new-password-1");
  });

  it("links expire, and only the newest works", async () => {
    const username = unique("lia").toLowerCase();
    const email = `${username}@example.com`;
    const id = (await admin.post("/api/users", { username, email, password: "lia-password-1", roleId: member }).expect(201)).body.user._id;
    await admin.post(`/api/users/${id}/password-link`).expect(200); // never signed in: a welcome link
    const first = (await tokenFrom(email)).token;
    await guest.post("/api/auth/forgot", { login: username }).expect(200);
    const second = (await tokenFrom(email)).token;
    expect((await guest.get(`/api/auth/password-link?token=${first}`)).status).toBe(404);
    await query(`UPDATE password_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [id]);
    expect((await guest.post("/api/auth/set-password", { token: second, password: "too-late-pass-1" })).status).toBe(400);
  });

  it("at most 3 links an hour per person", async () => {
    const username = unique("max").toLowerCase();
    const email = `${username}@example.com`;
    await admin.post("/api/users", { username, email, password: "max-password-1", roleId: member }).expect(201);
    for (let i = 0; i < 5; i++) await guest.post("/api/auth/forgot", { login: username }).expect(200);
    await processOutbox();
    expect(memoryMailbox.filter((m) => m.to === email).length).toBe(3);
  });
});
