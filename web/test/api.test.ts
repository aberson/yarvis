// web/src/api.ts: path ids are encodeURIComponent-ed (D22) and PATCH sends X-Yarvis: 1.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("api.patchTodo", () => {
  it("encodes a WhatsApp todo id (@, :, #) into one path segment", async () => {
    const fetchMock = stubFetch({});
    await api.patchTodo("wa:15555550123@s.whatsapp.net:3EB0A1C2D3E4F5#1", { status: "done" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/todos/wa%3A15555550123%40s.whatsapp.net%3A3EB0A1C2D3E4F5%231");
    expect(decodeURIComponent(url.slice("/api/todos/".length))).toBe(
      "wa:15555550123@s.whatsapp.net:3EB0A1C2D3E4F5#1",
    );
    expect(init?.method).toBe("PATCH");
    expect((init?.headers as Record<string, string>)["X-Yarvis"]).toBe("1");
    expect(init?.body).toBe(JSON.stringify({ status: "done" }));
  });

  it("getTodos passes the status filter; getQuarantine hits /api/quarantine", async () => {
    const fetchMock = stubFetch([]);
    await api.getTodos("all");
    await api.getQuarantine();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/todos?status=all",
      "/api/quarantine",
    ]);
  });
});

describe("api.startRefresh", () => {
  it("POSTs /api/refresh with X-Yarvis: 1; 202 -> started with the job id, 409 -> not started", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ jobId: "job-2026-10-19T18:02:11Z" }), { status: 202 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await api.startRefresh()).toEqual({ started: true, jobId: "job-2026-10-19T18:02:11Z" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/refresh");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-Yarvis"]).toBe("1");

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ running: true }), { status: 409 })),
    );
    expect(await api.startRefresh()).toEqual({ started: false });
  });
});
