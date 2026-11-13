import type { Request, Response } from "express";
import pg from "pg";
import { can } from "../auth/access.js";
import { env } from "../config/env.js";
import { query, type Db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { currentUser } from "../middleware/auth.js";
import { peekSchema } from "../schema/schemaRepo.js";
import type { CurrentUser } from "../types.js";

// Live updates: what changes reaches open browsers within a second.
//   - saves call emitChange()/emitNotification() inside their transaction
//     (pg_notify is delivered when it commits; a rolled-back save says nothing)
//   - each API process LISTENs once and passes events on to the people
//     connected to GET /api/events (Server-Sent Events): a change only to
//     people who can open that table, a notification only to its people
// Browsers don't redraw lists by themselves: they show "Hana changed this ·
// Refresh" (and the bell updates at once). No Redis needed: PostgreSQL does it.

export const LIVE_CHANNEL = "erp_live";
const HEARTBEAT_MS = 25_000; // keeps proxies and tunnels from closing the stream
const MAX_STREAM_MS = 30 * 60_000; // then the browser reconnects (and signs in again)
const MAX_PAYLOAD = 7_500; // pg_notify allows 8000 bytes

type ChangeEvent = { type: "change"; table: string; id: string | null; by: string; byName: string; deleted?: boolean };
type NotificationEvent = { type: "notification"; users: string[]; title: string; table: string | null; id: string | null };
type LiveEvent = ChangeEvent | NotificationEvent;

const emit = (event: LiveEvent, db?: Db) => query(`SELECT pg_notify($1, $2)`, [LIVE_CHANNEL, JSON.stringify(event)], db);

// a record (or, with id null, several) of `table` was added, changed or deleted
export const emitChange = (
  table: string,
  id: string | null,
  by: Pick<CurrentUser, "_id" | "fullName" | "username">,
  db?: Db,
  deleted = false
) => emit({ type: "change", table, id, by: by._id, byName: by.fullName || by.username, ...(deleted ? { deleted } : {}) }, db);

// new bell notifications for these people (sent in groups that fit a pg_notify)
export async function emitNotification(users: string[], n: { title: string; tableName?: string | null; recordId?: string | null }, db?: Db) {
  const base = { type: "notification" as const, title: n.title.slice(0, 200), table: n.tableName ?? null, id: n.recordId ?? null };
  const perGroup = Math.max(1, Math.floor((MAX_PAYLOAD - JSON.stringify(base).length) / 40));
  for (let i = 0; i < users.length; i += perGroup) await emit({ ...base, users: users.slice(i, i + perGroup) }, db);
}

/* ---------------- the browsers listening ---------------- */

type Client = { user: CurrentUser; res: Response };
const clients = new Set<Client>();

const send = (client: Client, name: string, data: unknown) => client.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

function deliver(event: LiveEvent) {
  for (const client of clients) {
    if (event.type === "notification") {
      if (event.users.includes(client.user._id)) send(client, "notification", { title: event.title, table: event.table, id: event.id });
      continue;
    }
    const schema = peekSchema(event.table);
    if (!schema || !can(client.user, schema, "view")) continue;
    send(client, "change", { table: event.table, id: event.id, by: event.by, byName: event.byName, deleted: Boolean(event.deleted) });
  }
}

// GET /api/events: one stream per open browser tab
export function eventsHandler(req: Request, res: Response) {
  const client: Client = { user: currentUser(req), res };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: pass it through as it comes
  });
  res.write("retry: 5000\n\n");
  clients.add(client);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  const limit = setTimeout(() => res.end(), MAX_STREAM_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(limit);
    clients.delete(client);
  });
}

export const connectedCount = () => clients.size;

// One LISTEN connection per API process. Returns a stop function.
export async function startLiveListener(): Promise<() => Promise<void>> {
  let client: pg.Client | null = null;
  let stopped = false;
  const connect = async () => {
    if (stopped) return;
    try {
      client = new pg.Client({ connectionString: env.databaseUrl });
      client.on("notification", (msg) => {
        try {
          deliver(JSON.parse(msg.payload ?? "{}") as LiveEvent);
        } catch (err) {
          logger.warn({ err }, "bad live event");
        }
      });
      client.on("error", (err) => {
        logger.warn({ err }, "live listener lost connection, reconnecting");
        client?.end().catch(() => {});
        setTimeout(connect, 2000);
      });
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
    } catch (err) {
      logger.warn({ err }, "live listener failed to connect, retrying");
      setTimeout(connect, 5000);
    }
  };
  await connect();
  return async () => {
    stopped = true;
    for (const c of clients) c.res.end();
    clients.clear();
    await client?.end().catch(() => {});
  };
}
