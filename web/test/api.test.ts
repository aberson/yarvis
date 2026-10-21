// web/src/api.ts: path ids are encodeURIComponent-ed (D22) and PATCH sends X-Yarvis: 1.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, conflictPacket } from "../src/api.js";

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

describe("api.savePacket / listPackets (S1 Step 11)", () => {
  const ID = "70000000-0000-4000-8000-0000000000cc";
  const edit = {
    expectedRevision: 3,
    draft: "d",
    checklist: [{ id: "70000000-0000-4000-8000-0000000000d1", text: "c", done: true }],
    questions: [],
    state: "handled" as const,
  };

  it("PATCHes the full edit with X-Yarvis: 1 and returns the saved packet", async () => {
    const fetchMock = stubFetch({ packet: { id: ID, revision: 4 } });
    const saved = await api.savePacket(ID, edit);
    expect(saved).toEqual({ id: ID, revision: 4 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/assistant/preparations/${ID}`);
    expect(init?.method).toBe("PATCH");
    expect((init?.headers as Record<string, string>)["X-Yarvis"]).toBe("1");
    expect(JSON.parse(init?.body as string)).toEqual(edit);
  });

  it("a 409 revision_conflict exposes currentPacket; other errors do not", async () => {
    const current = { id: ID, revision: 5, draft: "theirs" };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "revision_conflict", message: "m", currentPacket: current }),
            { status: 409 },
          ),
        ),
      ),
    );
    const err = await api.savePacket(ID, edit).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(conflictPacket(err)).toEqual(current);

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "bad_request" }), { status: 400 })),
      ),
    );
    expect(conflictPacket(await api.savePacket(ID, edit).catch((e: unknown) => e))).toBeNull();
    expect(conflictPacket(new Error("network"))).toBeNull();
  });

  it("listPackets GETs /api/assistant/preparations", async () => {
    const fetchMock = stubFetch({ packets: [], total: 0, omittedCount: 0 });
    expect(await api.listPackets()).toEqual({ packets: [], total: 0, omittedCount: 0 });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/assistant/preparations");
  });
});
