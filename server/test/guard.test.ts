// Localhost guard (D22, D28): Host allowlist follows the port the request arrived on plus the
// configured web port; mutating methods need X-Yarvis: 1.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, isAllowedHost } from "../src/index.js";
import { DEFAULT_SERVER_PORT } from "../src/config/paths.js";
import { tempPaths } from "./helpers.js";

const WEB_PORT = 5173;

function errorOf(res: { body: unknown }): unknown {
  return (res.body as { error?: unknown }).error;
}

describe("isAllowedHost", () => {
  // Only the edge cases the forged-Host integration tests below do not exercise.
  it("is case-insensitive and rejects a missing port, a suffix spoof and no Host", () => {
    expect(isAllowedHost("LOCALHOST:8787", [8787])).toBe(true);
    expect(isAllowedHost("127.0.0.1", [8787])).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.example.com:8787", [8787])).toBe(false);
    expect(isAllowedHost(undefined, [8787])).toBe(false);
  });
});

describe("createApp localhost guard on an ephemeral-port server", () => {
  const { paths, cleanup } = tempPaths();
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const app = createApp({ paths, fake: true, webPort: WEB_PORT });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  });

  it("accepts a Host naming the actual bound port (127.0.0.1 and localhost)", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await request(server).get("/api/health").set("Host", host);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, fake: true });
    }
  });

  it("accepts the configured web port (Vite proxy keeps the browser Host)", async () => {
    const res = await request(server).get("/api/health").set("Host", `127.0.0.1:${WEB_PORT}`);
    expect(res.status).toBe(200);
  });

  it("rejects a forged Host with 403 bad_host", async () => {
    for (const host of [
      "evil.example.com",
      `evil.example.com:${port}`,
      `127.0.0.1:${DEFAULT_SERVER_PORT}`,
      `127.0.0.1:${port + 1}`,
      `[::1]:${port}`,
    ]) {
      const res = await request(server).get("/api/health").set("Host", host);
      expect(res.status, host).toBe(403);
      expect(errorOf(res)).toBe("bad_host");
    }
  });

  it("rejects POST and PATCH without X-Yarvis: 1 with 403 missing_x_yarvis", async () => {
    const host = `127.0.0.1:${port}`;
    const patch = await request(server)
      .patch("/api/settings")
      .set("Host", host)
      .send({ pirate: true });
    expect(patch.status).toBe(403);
    expect(errorOf(patch)).toBe("missing_x_yarvis");

    const wrong = await request(server)
      .patch("/api/settings")
      .set("Host", host)
      .set("X-Yarvis", "0")
      .send({ pirate: true });
    expect(wrong.status).toBe(403);

    const post = await request(server).post("/api/settings").set("Host", host).send({});
    expect(post.status).toBe(403);
    expect(errorOf(post)).toBe("missing_x_yarvis");
  });

  it("checks Host before X-Yarvis on mutating requests", async () => {
    const res = await request(server)
      .patch("/api/settings")
      .set("Host", "evil.example.com")
      .set("X-Yarvis", "1")
      .send({ pirate: true });
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe("bad_host");
  });

  it("returns 404 not_found for an unknown route that passes the guard", async () => {
    const res = await request(server).get("/api/nope").set("Host", `127.0.0.1:${port}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});
