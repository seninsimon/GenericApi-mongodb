import { describe, expect, it } from "vitest";
import { memoryMailbox } from "../src/mail/mailer.js";
import { processOutbox } from "../src/mail/outbox.js";
import { login, unique } from "./helpers.js";

// workspace/CHAT_PLAN.md: comments on records, and team chat.
describe("Comments and team chat", async () => {
  const admin = await login();
  const dept = async (name: string) => (await admin.post("/api/departments", { name: unique(name) })).body.department;
  const eng = await dept("Eng");
  const hr = await dept("HR");
  const table = unique("tasks");
  await admin.post("/api/schema", { tableName: table, byDepartment: true, columns: [{ name: "title", label: "Title" }] }).expect(200);
  await admin.put(`/api/schema/${table}`, { departmentIds: [eng._id, hr._id] }).expect(200);
  const role = (await admin.post("/api/roles", { name: unique("Work"), permissions: { [table]: { view: true, create: true, edit: true } } })).body.role;
  const person = async (name: string, departmentIds: string[]) => {
    const username = unique(name).toLowerCase();
    const res = await admin.post("/api/users", { username, fullName: name, email: `${username}@example.com`, password: "pass-123-pass", roleId: role._id, departmentIds }).expect(201);
    return { id: res.body.user._id as string, username, client: await login(username, "pass-123-pass") };
  };
  const sam = await person("Sam", [eng._id]);
  const hana = await person("Hana", [eng._id]);
  const kiran = await person("Kiran", [hr._id]); // can't see Engineering's records
  const bell = async (who: typeof sam) => ((await who.client.get("/api/notifications")).body.items as { title: string }[]).map((n) => n.title);

  describe("comments on a record", () => {
    let id: string;
    it("mentions tell people who can see the record, and warn about the rest", async () => {
      id = (await sam.client.post(`/api/table/${table}`, { title: "Fix login", _departmentIds: [eng._id] }).expect(200)).body.data.insertedId;
      const res = await sam.client.post(`/api/table/${table}/${id}/comments`, { body: `@${hana.username} can you check? cc @${kiran.username}` }).expect(201);
      expect(res.body.warning).toBe("Kiran can't see this record, so wasn't told");
      expect(await bell(hana)).toContain("Sam mentioned you on Fix login");
      expect(await bell(kiran)).not.toContain("Sam mentioned you on Fix login");
      // comment mentions are about work: emailed by the person's choice
      await processOutbox();
      expect(memoryMailbox.some((m) => m.subject === "Sam mentioned you on Fix login")).toBe(true);
    });

    it("the people in the conversation hear about replies", async () => {
      await hana.client.post(`/api/table/${table}/${id}/comments`, { body: "Done, it was the cookie." }).expect(201);
      expect(await bell(sam)).toContain("Hana commented on Fix login");
      const list = (await sam.client.get(`/api/table/${table}/${id}/comments`).expect(200)).body;
      expect(list.map((c: { name: string }) => c.name)).toEqual(["Sam", "Hana"]);
      expect((await kiran.client.get(`/api/table/${table}/${id}/comments`)).status).toBe(404); // can't see the record
    });

    it("only the author edits; the author or an admin deletes", async () => {
      const list = (await sam.client.get(`/api/table/${table}/${id}/comments`)).body;
      const hanas = list[1]._id;
      expect((await sam.client.put(`/api/table/${table}/${id}/comments/${hanas}`, { body: "x" })).status).toBe(403);
      await hana.client.put(`/api/table/${table}/${id}/comments/${hanas}`, { body: "Done: it was the session cookie." }).expect(200);
      await admin.del(`/api/table/${table}/${id}/comments/${hanas}`).expect(200);
      expect((await sam.client.get(`/api/table/${table}/${id}/comments`)).body.length).toBe(1);
    });

    it("can be switched off", async () => {
      await admin.put("/api/chat/settings", { comments: false }).expect(200);
      expect((await sam.client.get(`/api/table/${table}/${id}/comments`)).status).toBe(404);
      await admin.put("/api/chat/settings", { comments: true }).expect(200);
    });
  });

  describe("team chat", () => {
    it("is off until an admin switches it on", async () => {
      expect((await sam.client.get("/api/chat")).body.enabled).toBe(false);
      await admin.put("/api/chat/settings", { teamChat: true }).expect(200);
      expect((await sam.client.get("/api/chat")).body.enabled).toBe(true);
      expect((await sam.client.put("/api/chat/settings", { teamChat: false })).status).toBe(403);
    });

    it("everyone and your department's channel are there, ready", async () => {
      const names = (await sam.client.get("/api/chat")).body.channels.map((c: { name: string }) => c.name);
      expect(names).toEqual(expect.arrayContaining(["everyone", eng.name]));
      expect(names).not.toContain(hr.name); // not Kiran's
      const adminNames = (await admin.get("/api/chat")).body.channels.map((c: { name: string }) => c.name);
      expect(adminNames).toEqual(expect.arrayContaining([eng.name, hr.name])); // admins see department channels
    });

    it("messages, mentions, unread counts and reading", async () => {
      const channels = (await sam.client.get("/api/chat")).body.channels;
      const engChannel = channels.find((c: { name: string }) => c.name === eng.name)._id;
      await sam.client.post(`/api/chat/${engChannel}/messages`, { body: `Standup in 5, @${hana.username}` }).expect(201);
      await sam.client.post(`/api/chat/${engChannel}/messages`, { body: "Agenda: the release" }).expect(201);
      const hanaView = (await hana.client.get("/api/chat")).body;
      expect(hanaView.channels.find((c: { _id: string }) => c._id === engChannel)).toMatchObject({ unread: 2, mentions: 1 });
      expect(await bell(hana)).toContain(`Sam mentioned you in #${eng.name}`);
      // chat isn't emailed
      await processOutbox();
      expect(memoryMailbox.some((m) => m.subject.includes("mentioned you in #"))).toBe(false);

      const { messages } = (await hana.client.get(`/api/chat/${engChannel}/messages`).expect(200)).body;
      expect(messages.map((m: { body: string }) => m.body)).toEqual([`Standup in 5, @${hana.username}`, "Agenda: the release"]);
      await hana.client.post(`/api/chat/${engChannel}/read`, { lastId: messages.at(-1)._id }).expect(200);
      expect((await hana.client.get("/api/chat")).body.channels.find((c: { _id: string }) => c._id === engChannel).unread).toBe(0);
      // reading the conversation also reads its "mentioned you" notice
      const notices = (await hana.client.get("/api/notifications")).body.items as { title: string; read: boolean }[];
      expect(notices.find((n) => n.title === `Sam mentioned you in #${eng.name}`)?.read).toBe(true);
      expect((await kiran.client.get(`/api/chat/${engChannel}/messages`)).status).toBe(404);
    });

    it("reactions, editing and deleting your own", async () => {
      const everyone = (await sam.client.get("/api/chat")).body.channels.find((c: { kind: string }) => c.kind === "everyone")._id;
      const id = (await sam.client.post(`/api/chat/${everyone}/messages`, { body: "Lunch at 1?" })).body._id;
      await hana.client.post(`/api/chat/messages/${id}/reactions`, { emoji: "👍" }).expect(200);
      await kiran.client.post(`/api/chat/messages/${id}/reactions`, { emoji: "👍" }).expect(200);
      expect((await hana.client.post(`/api/chat/messages/${id}/reactions`, { emoji: "🦄" })).status).toBe(400);
      let msg = (await sam.client.get(`/api/chat/${everyone}/messages`)).body.messages.find((m: { _id: string }) => m._id === id);
      expect(msg.reactions).toEqual([{ emoji: "👍", count: 2, mine: false }]);
      expect((await hana.client.put(`/api/chat/messages/${id}`, { body: "hijack" })).status).toBe(403);
      await sam.client.put(`/api/chat/messages/${id}`, { body: "Lunch at 1:30?" }).expect(200);
      await sam.client.del(`/api/chat/messages/${id}`).expect(200);
      msg = (await sam.client.get(`/api/chat/${everyone}/messages`)).body.messages.find((m: { _id: string }) => m._id === id);
      expect(msg).toMatchObject({ deleted: true, body: "" });
    });

    it("direct messages are private, admins included", async () => {
      const dm = (await sam.client.post("/api/chat/dm", { userId: kiran.id }).expect(200)).body._id;
      expect((await kiran.client.post("/api/chat/dm", { userId: sam.id })).body._id).toBe(dm); // one per pair
      await sam.client.post(`/api/chat/${dm}/messages`, { body: "Hi Kiran" }).expect(201);
      expect((await kiran.client.get(`/api/chat/${dm}/messages`)).body.messages[0].body).toBe("Hi Kiran");
      expect((await hana.client.get(`/api/chat/${dm}/messages`)).status).toBe(404);
      expect((await admin.get(`/api/chat/${dm}/messages`)).status).toBe(404);
      expect((await kiran.client.get("/api/chat")).body.channels.find((c: { _id: string }) => c._id === dm)).toMatchObject({ kind: "dm", name: "Sam", unread: 1 });
      // search only finds what you can read
      expect((await hana.client.get("/api/chat/search?q=Kiran")).body).toEqual([]);
      expect((await kiran.client.get("/api/chat/search?q=Kiran")).body.length).toBe(1);
    });

    it("groups, calls, and switching direct messages off", async () => {
      const group = (await sam.client.post("/api/chat/groups", { name: "Release crew", userIds: [hana.id] }).expect(201)).body._id;
      const call = (await sam.client.post(`/api/chat/${group}/messages`, { call: true }).expect(201)).body;
      expect(call.url).toMatch(/^https:\/\/meet\.jit\.si\/Zenin-/);
      expect((await hana.client.get(`/api/chat/${group}/messages`)).body.messages[0]).toMatchObject({ kind: "call", body: call.url });
      await hana.client.del(`/api/chat/${group}/membership`).expect(200);
      expect((await hana.client.get(`/api/chat/${group}/messages`)).status).toBe(404);

      await admin.put("/api/chat/settings", { directMessages: false }).expect(200);
      expect((await sam.client.post("/api/chat/dm", { userId: hana.id })).status).toBe(403);
      await admin.put("/api/chat/settings", { directMessages: true, teamChat: false }).expect(200);
    });
  });
});
