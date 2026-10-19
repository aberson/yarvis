// Access log wired through createApp: one line per /api request, no query string, no body.
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { tempPaths } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("access log", () => {
  it("writes exactly one line per /api request with method, path and status", async () => {
    const { paths, cleanup } = tempPaths({ seedSettings: true });
    cleanups.push(cleanup);
    const lines: string[] = [];
    const app = createApp({ paths, fake: true, webPort: 5173, accessLog: (l) => lines.push(l) });

    await request(app)
      .patch("/api/settings?secret=1")
      .set("Host", "127.0.0.1:5173")
      .set("X-Yarvis", "1")
      .send({ pirate: true })
      .expect(200);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[api\] PATCH \/api\/settings 200 \d+ms$/);
  });
});
