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
  type QuarantineItem,
  type RefreshStarted,
  type RefreshStatus,
  type RunResponse,
  type Settings,
  type SettingsPatch,
  type SettingsResponse,
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
    try {
      const err = (await res.json()) as Partial<ApiErrorBody>;
      if (typeof err.error === "string") code = err.error;
      if (typeof err.message === "string") message = err.message;
    } catch {
      // non-JSON error body (e.g. the proxy could not reach the server)
    }
    throw new ApiError(res.status, code, message);
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
};
