import { describe, expect, it } from "vitest";
import { storage, UPLOAD_URL_PREFIX } from "../src/storage.js";
import { anonymous, login, unique } from "./helpers.js";

describe("files and tables", async () => {
  const admin = await login();

  it("streams uploads, serves them to logged-in users only, supports ranges", async () => {
    const res = await admin
      .upload("/api/upload")
      .attach("files", Buffer.from("hello rustfs 0123456789"), { filename: "my phötö #1.txt", contentType: "text/plain" });
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("my phötö #1.txt");
    const url: string = res.body[0].url;
    expect(url.startsWith(UPLOAD_URL_PREFIX)).toBe(true);

    const file = await admin.get(encodeURI(url));
    expect(file.status).toBe(200);
    expect(file.headers["content-security-policy"]).toBe("sandbox");
    expect(file.text).toBe("hello rustfs 0123456789");

    const range = await admin.agent.get(encodeURI(url)).set("Range", "bytes=6-11");
    expect(range.status).toBe(206);
    expect(range.text).toBe("rustfs");

    expect((await (await anonymous()).get(encodeURI(url))).status).toBe(401);
  });

  it("rejects files over the size limit without keeping them", async () => {
    const before = (storage as unknown as { objects: Map<string, unknown> }).objects.size;
    const res = await admin.upload("/api/upload").attach("files", Buffer.alloc(1.5 * 1024 * 1024), "big.bin");
    expect(res.status).toBe(413);
    expect((storage as unknown as { objects: Map<string, unknown> }).objects.size).toBe(before);
  });

  it("never serves job files through /uploads", async () => {
    await storage.put("exports/secret.csv", Buffer.from("x"), "text/csv");
    expect((await admin.get("/uploads/exports/secret.csv")).status).toBe(404);
  });

  it("deletes a table with its records and files, but not while linked", async () => {
    const docs = unique("docs");
    const linker = unique("linker");
    await admin.post("/api/schema", { tableName: docs, columns: [{ name: "file", type: "file" }] }).expect(200);
    await admin.post("/api/schema", { tableName: linker, columns: [{ name: "doc", type: "relation", ref: docs }] }).expect(200);

    const url = (await admin.upload("/api/upload").attach("files", Buffer.from("pdf"), "c.pdf")).body[0].url;
    await admin.post(`/api/table/${docs}`, { file: url }).expect(200);

    const blocked = await admin.del(`/api/schema/${docs}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain(`${linker}.doc`);

    await admin.del(`/api/schema/${linker}/column/doc`).expect(200);
    const res = await admin.del(`/api/schema/${docs}`);
    expect(res.body.deletedFiles).toBe(1);
    expect((await admin.get(encodeURI(url))).status).toBe(404);
    expect((await admin.get(`/api/schema/${docs}`)).status).toBe(404);
    // the name can be reused
    await admin.post("/api/schema", { tableName: docs }).expect(200);
    expect((await admin.get(`/api/table/${docs}`)).body.total).toBe(0);
  });
});
