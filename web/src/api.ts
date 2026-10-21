// Typed fetch wrappers (plan §5). Relative /api paths through the Vite proxy (D31); every mutating
// call sends X-Yarvis: 1 (D22); path ids are wrapped in encodeURIComponent (pathId).
import {
  API_ERROR_CODES,
  X_YARVIS_HEADER,
  X_YARVIS_VALUE,
  type ApiErrorBody,
  type ApiErrorCode,
  type AssistantRun,
  type HealthResponse,
  type LatestBriefingResponse,
  type LatestRunResponse,
  type PacketEdit,
  type PacketListResponse,
  type PacketResponse,
  type PreparationPacket,
  type QuarantineItem,
  type RefreshStarted,
  type RefreshStatus,
  type RevisionConflictBody,
  type RunResponse,
  type Settings,
  type SettingsPatch,
  type SettingsResponse,
  type StartPreparationRequest,
  type StartPreparationResponse,
  type StatusResponse,
  type Todo,
  type TodoFilter,
  type TodoPatch,
} from "@yarvis/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The parsed JSON error body (e.g. a save conflict's `currentPacket`), when there was one. */
    readonly body: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The server's typed error code, or null for a non-API failure (e.g. the proxy's 502). */
  get apiCode(): ApiErrorCode | null {
    return (API_ERROR_CODES as readonly string[]).includes(this.code)
      ? (this.code as ApiErrorCode)
      : null;
  }
}

/**
 * True when a request may have reached the server without us seeing its answer (network error,
 * proxy failure, non-API 5xx): the caller must rediscover state instead of assuming nothing ran.
 */
export function isLostResponse(err: unknown): boolean {
  if (err instanceof ApiError) return err.apiCode === null && err.status >= 500;
  return true;
}

/**
 * The current saved packet a stale save's 409 revision_conflict carries (S1.5 "Editing"), or null
 * when the error is anything else (the caller then keeps its local edits and shows the error).
 */
export function conflictPacket(err: unknown): PreparationPacket | null {
  if (!(err instanceof ApiError) || err.apiCode !== "revision_conflict") return null;
  const current = (err.body as Partial<RevisionConflictBody> | null)?.currentPacket;
  return current && typeof current === "object" ? current : null;
}

/** Encodes one path segment (ids contain `:`, `@` and `#`). */
export function pathId(id: string): string {
  return encodeURIComponent(id);
}

type Method = "GET" | "POST" | "PATCH";

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers[X_YARVIS_HEADER] = X_YARVIS_VALUE;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let code = "http_error";
    let message = `${method} ${path} failed with ${res.status}`;
    let errBody: Record<string, unknown> | null = null;
    try {
      const err = (await res.json()) as Partial<ApiErrorBody> | null;
      if (err && typeof err === "object") {
        errBody = err;
        if (typeof err.error === "string") code = err.error;
        if (typeof err.message === "string") message = err.message;
      }
    } catch {
      // non-JSON error body (e.g. the proxy could not reach the server)
    }
    throw new ApiError(res.status, code, message, errBody);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>("GET", "/api/health"),
  getSettings: () => request<SettingsResponse>("GET", "/api/settings"),
  patchSettings: (patch: SettingsPatch) => request<Settings>("PATCH", "/api/settings", patch),
  getTodos: (status: TodoFilter = "open") =>
    request<Todo[]>("GET", `/api/todos?status=${encodeURIComponent(status)}`),
  patchTodo: (id: string, patch: TodoPatch) =>
    request<Todo>("PATCH", `/api/todos/${pathId(id)}`, patch),
  getQuarantine: () => request<QuarantineItem[]>("GET", "/api/quarantine"),
  /** POST /api/refresh: 202 -> {started, jobId}; 409 (a job holds the lock) -> {started: false}. */
  startRefresh: async (): Promise<{ started: true; jobId: string } | { started: false }> => {
    try {
      const body = await request<RefreshStarted>("POST", "/api/refresh");
      return { started: true, jobId: body.jobId };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return { started: false };
      throw err;
    }
  },
  getRefreshStatus: () => request<RefreshStatus>("GET", "/api/refresh/status"),
  getStatus: () => request<StatusResponse>("GET", "/api/status"),
  /** POST /api/assistant/briefings: `requestId` is generated once per intentional action. */
  startBriefing: async (requestId: string): Promise<AssistantRun> =>
    (await request<RunResponse>("POST", "/api/assistant/briefings", { requestId })).run,
  getLatestBriefing: async () =>
    (await request<LatestBriefingResponse>("GET", "/api/assistant/briefings/latest")).briefing,
  getLatestRun: async () =>
    (await request<LatestRunResponse>("GET", "/api/assistant/runs/latest")).run,
  getRun: async (id: string): Promise<AssistantRun> =>
    (await request<RunResponse>("GET", `/api/assistant/runs/${pathId(id)}`)).run,
  /**
   * POST /api/assistant/preparations: 202 {run} to follow, or 200 {packet} when the Todo already
   * has one. `requestId` is generated once per intentional action (reused on an HTTP retry).
   */
  startPreparation: (body: StartPreparationRequest) =>
    request<StartPreparationResponse>("POST", "/api/assistant/preparations", body),
  getPacket: async (id: string): Promise<PreparationPacket> =>
    (await request<PacketResponse>("GET", `/api/assistant/preparations/${pathId(id)}`)).packet,
  /** GET /api/assistant/preparations: the newest 100 saved packets with total + omitted count. */
  listPackets: () => request<PacketListResponse>("GET", "/api/assistant/preparations"),
  /** PATCH /api/assistant/preparations/:id: compare-and-swap save (409 carries currentPacket). */
  savePacket: async (id: string, edit: PacketEdit): Promise<PreparationPacket> =>
    (await request<PacketResponse>("PATCH", `/api/assistant/preparations/${pathId(id)}`, edit))
      .packet,
};
