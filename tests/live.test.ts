import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { startLiveListener } from "../src/live/events.js";
import { getApp, login, unique } from "./helpers.js";

// Live updates (Server-Sent Events) and "changed while you were editing".
describe("Live updates", async () => {
  const app = await getApp();
  const server = http.createServer(app).listen(0);
  const port = (server.address() as AddressInfo).port;
  const stopLive = await startLiveListener();
  afterAll(async () => {
    await stopLive();
    server.close();
  });

  const admin = await login();
  const table = unique("tickets");
  const hidden = unique("secret");
  for (const t of [table, hidden]) {
    await admin.post("/api/schema", { tableName: t, byDepartment: false, columns: [{ name: "title", label: "Title" }, { name: "owner", label: "Owner", type: "user" }] }).expect(200);
  }
  const role = (await admin.post("/api/roles", { name: unique("Desk"), permissions: { [table]: { view: true, create: true, edit: true } } })).body.role;
  const person = async (name: string) => {
    const username = unique(name).toLowerCase();
    await admin.post("/api/users", { username, fullName: name, password: "pass-123-pass", roleId: role._id }).expect(201);
    const res = await request(app).post("/api/auth/login").set("X-Requested-With", "XMLHttpRequest").send({ username, password: "pass-123-pass" });
    return { cookie: (res.headers["set-cookie"] as unknown as string[]).map((c) => c.split(";")[0]).join("; "), client: await login(username, "pass-123-pass"), id: res.body.user._id as string };
  };
  const sam = await person("Sam");
  const hana = await person("Hana");

  // collect what a browser tab would get, for a moment
  const listen = (cookie: string) =>
    new Promise<{ events: { name: string; data: Record<string, unknown> }[]; close: () => void }>((resolve) => {
      const events: { name: string; data: Record<string, unknown> }[] = [];
      const req = http.get({ port, path: "/api/events", headers: { cookie } }, (res) => {
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const name = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (name && data) events.push({ name, data: JSON.parse(data) });
          }
        });
        resolve({ events, close: () => req.destroy() });
      });
    });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("tells open screens about changes they may see, and people about their notifications", async () => {
    const samTab = await listen(sam.cookie);
    await wait(200);
    const id = (await admin.post(`/api/table/${table}`, { title: "Printer jam", owner: sam.id }).expect(200)).body.data.insertedId;
    await admin.post(`/api/table/${hidden}`, { title: "Not for Sam" }).expect(200);
    await hana.client.put(`/api/table/${table}/${id}`, { title: "Printer jam (2nd floor)" }).expect(200);
    await admin.del(`/api/table/${table}/${id}`).expect(200);
    await wait(500);
    samTab.close();

    const changes = samTab.events.filter((e) => e.name === "change").map((e) => e.data);
    expect(changes).toEqual([
      expect.objectContaining({ table, id, byName: "Administrator", deleted: false }),
      expect.objectContaining({ table, id, byName: "Hana", deleted: false }),
      expect.objectContaining({ table, id, deleted: true }),
    ]);
    expect(changes.some((c) => c.table === hidden)).toBe(false); // a table Sam can't open
    const bell = samTab.events.filter((e) => e.name === "notification").map((e) => e.data);
    expect(bell).toEqual([expect.objectContaining({ title: "Administrator put you as Owner", table, id })]);
  });

  it("refuses a stream without signing in", async () => {
    expect((await request(app).get("/api/events")).status).toBe(401);
  });

  it("asks before overwriting what someone else saved meanwhile", async () => {
    const id = (await admin.post(`/api/table/${table}`, { title: "Draft" }).expect(200)).body.data.insertedId;
    const opened = (await sam.client.get(`/api/table/${table}/${id}`)).body._updatedAt; // Sam opens the form
    await wait(5);
    await hana.client.put(`/api/table/${table}/${id}`, { title: "Hana's version" }).expect(200); // Hana saves first
    const clash = await sam.client.put(`/api/table/${table}/${id}`, { title: "Sam's version", _expectedUpdatedAt: opened });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toBe("Hana changed this record while you were editing it");
    expect((await admin.get(`/api/table/${table}/${id}`)).body.title).toBe("Hana's version");
    // "save mine anyway", or with the version he now has: fine
    const now = (await sam.client.get(`/api/table/${table}/${id}`)).body._updatedAt;
    await sam.client.put(`/api/table/${table}/${id}`, { title: "Sam's version", _expectedUpdatedAt: now }).expect(200);
    await sam.client.put(`/api/table/${table}/${id}`, { title: "Sam's version 2" }).expect(200);
  });
});
