import { describe, expect, it } from "vitest";
import { login, setupWorld, unique } from "./helpers.js";

// Notifications ("you were put as Assignee") and automations ("when Status
// becomes Approved -> set the date, tell people").
describe("Notifications and automations", async () => {
  const admin = await login();
  const world = await setupWorld(admin, {
    columns: [
      { name: "title", label: "Title" },
      { name: "assignee", label: "Assignee", type: "user" },
      { name: "reviewer", label: "Reviewer", type: "user" },
      { name: "status", label: "Status", type: "choice", options: ["Open", "Approved"], default: "Open" },
      { name: "approved_on", label: "Approved on", type: "date" },
    ],
  });
  const t = world.table;
  const username = unique("reviewer").toLowerCase();
  const reviewerId = (await admin.post("/api/users", { username, password: "user-pass-123", roleId: world.role._id, departmentIds: [world.dept._id] }))
    .body.user._id as string;
  const reviewer = await login(username, "user-pass-123");
  const me = (await world.user.get("/api/auth/me")).body;
  const userId = (me.user ?? me)._id as string;
  const bell = async (client: typeof admin) => (await client.get("/api/notifications")).body;

  it("tells people they were picked, but not themselves", async () => {
    await world.user.post(`/api/table/${t}`, { title: "Self", assignee: userId }).expect(200);
    expect((await bell(world.user)).unread).toBe(0);
    await admin.post(`/api/table/${t}`, { title: "Report", assignee: userId }).expect(200);
    const mine = await bell(world.user);
    expect(mine.unread).toBe(1);
    expect(mine.items[0]).toMatchObject({ title: "Administrator put you as Assignee", read: false, tableName: t });
    expect(mine.items[0].body).toMatch(/^Report/);
  });

  it("checks automations when they're saved", async () => {
    const bad = await admin.post(`/api/schema/${t}/automations`, { trigger: { when: "changed", column: "nope" }, actions: [{ do: "notify", who: "$creator" }] });
    expect(bad.status).toBe(400);
    const noAction = await admin.post(`/api/schema/${t}/automations`, { trigger: { when: "created" }, actions: [] });
    expect(noAction.body.message).toMatch(/at least one/);
    expect((await world.user.get(`/api/schema/${t}/automations`)).status).toBe(403); // admins only
  });

  it("runs an automation when its trigger happens", async () => {
    await admin
      .post(`/api/schema/${t}/automations`, {
        name: "On approval",
        trigger: { when: "changed", column: "status", to: "Approved" },
        actions: [
          { do: "set", column: "approved_on", value: "today" },
          { do: "notify", who: "$creator", message: "Approved!" },
          { do: "notify", who: "reviewer" },
        ],
      })
      .expect(200);
    const id = (await world.user.post(`/api/table/${t}`, { title: "Leave", reviewer: reviewerId }).expect(200)).body.data.insertedId;
    await admin.put(`/api/table/${t}/${id}`, { title: "Leave (renamed)" }).expect(200); // not the trigger
    expect((await admin.get(`/api/table/${t}/${id}`)).body.approved_on ?? null).toBeNull();

    await admin.put(`/api/table/${t}/${id}`, { status: "Approved" }).expect(200);
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect((await admin.get(`/api/table/${t}/${id}`)).body.approved_on).toBe(iso);
    expect((await bell(world.user)).items[0]).toMatchObject({ title: "Approved!", actor: "Administrator" });
    const forReviewer = (await bell(reviewer)).items.map((n: { title: string }) => n.title);
    expect(forReviewer).toContain("Leave (renamed): Status is now Approved");
  });

  it("doesn't notify from previews", async () => {
    const before = (await bell(world.user)).unread;
    await admin.post(`/api/table/${t}?preview=1`, { title: "Preview", assignee: userId }).expect(200);
    expect((await bell(world.user)).unread).toBe(before);
  });

  it("marks notifications as read", async () => {
    const { items } = await bell(world.user);
    await world.user.post("/api/notifications/read", { ids: [items[0]._id] }).expect(200);
    expect((await bell(world.user)).items[0].read).toBe(true);
    await world.user.post("/api/notifications/read", {}).expect(200);
    expect((await bell(world.user)).unread).toBe(0);
  });

  it("can be switched off", async () => {
    const [a] = (await admin.get(`/api/schema/${t}/automations`)).body;
    await admin.put(`/api/schema/${t}/automations/${a._id}`, { ...a, enabled: false }).expect(200);
    const id = (await world.user.post(`/api/table/${t}`, { title: "Second" }).expect(200)).body.data.insertedId;
    await admin.put(`/api/table/${t}/${id}`, { status: "Approved" }).expect(200);
    expect((await admin.get(`/api/table/${t}/${id}`)).body.approved_on ?? null).toBeNull();
    await admin.del(`/api/schema/${t}/automations/${a._id}`).expect(200);
  });
});
