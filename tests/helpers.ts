import request from "supertest";
import type { Express } from "express";
import { afterAll } from "vitest";
import { createApp } from "../src/app.js";
import { ensureInitialAdmin } from "../src/auth/bootstrap.js";
import { migrate } from "../src/db/migrate.js";
import { pool } from "../src/db/pool.js";
import { ensureAllDataTables } from "../src/schema/schemaRepo.js";

export const ADMIN = { username: "admin", password: "admin-test-pass" };

let app: Express | null = null;

export async function getApp(): Promise<Express> {
  if (app) return app;
  await migrate();
  await ensureAllDataTables();
  await ensureInitialAdmin();
  app = createApp();
  afterAll(async () => {
    await pool.end();
  });
  return app;
}

// A logged-in client that keeps its cookie and sends the CSRF header.
export type Client = ReturnType<typeof wrap>;

const wrap = (agent: ReturnType<typeof request.agent>) => {
  const xhr = <T extends { set: (k: string, v: string) => T }>(req: T) => req.set("X-Requested-With", "XMLHttpRequest");
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => xhr(agent.post(url)).send(body),
    put: (url: string, body?: object) => xhr(agent.put(url)).send(body),
    del: (url: string) => xhr(agent.delete(url)),
    upload: (url: string) => xhr(agent.post(url)),
  };
};

export async function anonymous() {
  return wrap(request.agent(await getApp()));
}

export async function login(username = ADMIN.username, password = ADMIN.password): Promise<Client> {
  const client = wrap(request.agent(await getApp()));
  const res = await client.post("/api/auth/login", { username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

// Unique names so test files can share one database.
let counter = 0;
export const unique = (prefix: string) => `${prefix}_${process.pid}_${Date.now() % 100000}_${counter++}`;

// Create a department, a table assigned to it, a role and a user in one go.
export async function setupWorld(admin: Client, opts: { perms?: Record<string, boolean>; columns?: object[] } = {}) {
  const dept = (await admin.post("/api/departments", { name: unique("Dept") })).body.department;
  const table = unique("tbl");
  await admin.post("/api/schema", { tableName: table, columns: opts.columns ?? [{ name: "name", label: "Name" }] }).expect(200);
  await admin.put(`/api/schema/${table}`, { departmentIds: [dept._id] }).expect(200);
  const role = (
    await admin.post("/api/roles", {
      name: unique("Role"),
      permissions: { [table]: opts.perms ?? { view: true, create: true, edit: true, delete: true } },
    })
  ).body.role;
  const username = unique("user").toLowerCase().slice(0, 40);
  await admin
    .post("/api/users", { username, password: "user-pass-123", roleId: role._id, departmentIds: [dept._id] })
    .expect(201);
  return { dept, table, role, username, user: await login(username, "user-pass-123") };
}
