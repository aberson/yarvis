// Typed fetch wrappers (plan §5). Relative /api paths through the Vite proxy (D31); every mutating
// call sends X-Yarvis: 1 (D22); path ids are wrapped in encodeURIComponent (pathId).
import {
  X_YARVIS_HEADER,
  X_YARVIS_VALUE,
  type ApiErrorBody,
  type HealthResponse,
  type QuarantineItem,
  type RefreshStarted,
  type RefreshStatus,
  type Settings,
  type SettingsPatch,
  type SettingsResponse,
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
};
