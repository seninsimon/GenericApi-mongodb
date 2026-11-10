import request from "supertest";
import { describe, expect, it } from "vitest";
import { ADMIN, anonymous, getApp, login, unique } from "./helpers.js";

describe("authentication", () => {
  it("rejects state-changing requests without the CSRF header", async () => {
    const res = await request(await getApp()).post("/api/auth/login").send(ADMIN);
    expect(res.status).toBe(403);
  });

  it("logs in with an httpOnly SameSite=Lax cookie", async () => {
    const anon = await anonymous();
    const res = await anon.post("/api/auth/login", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.user.role.isAdmin).toBe(true);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await anon.get("/api/auth/me")).status).toBe(200);
  });

  it("marks the cookie Secure only on HTTPS requests (e.g. through a tunnel)", async () => {
    const app = await getApp();
    const send = (proto?: string) => {
      const req = request(app).post("/api/auth/login").set("X-Requested-With", "XMLHttpRequest");
      if (proto) req.set("X-Forwarded-Proto", proto);
      return req.send(ADMIN);
    };
    const overHttp = await send();
    expect(overHttp.status).toBe(200);
    expect(String(overHttp.headers["set-cookie"])).not.toMatch(/;\s*Secure/i);
    const overHttps = await send("https");
    expect(overHttps.status).toBe(200);
    expect(String(overHttps.headers["set-cookie"])).toMatch(/;\s*Secure/i);
  });

  it("rejects bad credentials and requires login", async () => {
    const anon = await anonymous();
    expect((await anon.post("/api/auth/login", { username: "admin", password: "wrong-password" })).status).toBe(401);
    expect((await anon.post("/api/auth/login", { username: "ghost", password: "whatever-1" })).status).toBe(401);
    expect((await anon.get("/api/schema")).status).toBe(401);
    expect((await anon.get("/uploads/x.png")).status).toBe(401);
  });

  it("throttles repeated failed logins (shared in Postgres)", async () => {
    const anon = await anonymous();
    const username = unique("nobody");
    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (await anon.post("/api/auth/login", { username, password: "bad-password" })).status;
    }
    expect(status).toBe(429);
  });

  it("logout ends the session", async () => {
    const admin = await login();
    expect((await admin.post("/api/auth/logout")).status).toBe(200);
    expect((await admin.get("/api/auth/me")).status).toBe(401);
  });

  it("changing the password signs out other devices", async () => {
    const admin = await login();
    const role = (await admin.get("/api/roles")).body.find((r: { isAdmin: boolean }) => !r.isAdmin)
      ?? (await admin.post("/api/roles", { name: unique("R") })).body.role;
    const username = unique("pw").toLowerCase();
    await admin.post("/api/users", { username, password: "first-pass-1", roleId: role._id }).expect(201);

    const deviceA = await login(username, "first-pass-1");
    const deviceB = await login(username, "first-pass-1");
    expect((await deviceA.put("/api/auth/password", { currentPassword: "nope", newPassword: "second-pass-1" })).status).toBe(400);
    expect((await deviceA.put("/api/auth/password", { currentPassword: "first-pass-1", newPassword: "short" })).status).toBe(400);
    expect((await deviceA.put("/api/auth/password", { currentPassword: "first-pass-1", newPassword: "second-pass-1" })).status).toBe(200);
    expect((await deviceA.get("/api/auth/me")).status).toBe(200);
    expect((await deviceB.get("/api/auth/me")).status).toBe(401);
    await expect(login(username, "first-pass-1")).rejects.toThrow();
    await login(username, "second-pass-1");
  });

  it("records logins in the audit log", async () => {
    const admin = await login();
    const res = await admin.get("/api/audit?entity=session&action=login&limit=5");
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ action: "login", username: "admin" });
  });
});
