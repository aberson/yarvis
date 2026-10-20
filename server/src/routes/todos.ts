// GET /api/todos and PATCH /api/todos/:id (plan §6, D22, P6).
//   - GET reads the Todos tab through a 10 s cache (invalidated by a successful PATCH; Step 6 also
//     invalidates it on job completion via TodosCache.invalidate), filtered by ?status=open|done|all
//     (default open). A to-do whose message has an ACTIVE (unreleased) Quarantine row is never
//     listed: a message quarantined after its row was written (a lowered threshold, D16) disappears
//     from the list without any sheet row being deleted, and reappears when it is released.
//   - PATCH is update-only: `:id` is encodeURIComponent(todoId), decoded by Express and validated
//     with shared/src/ids.ts (400 bad_id); 404 not_found when the id is not already in the tab (no
//     sheet write); otherwise writes ONLY `status` + `updated_at`, never appends.
import { Router } from "express";
import { z } from "zod";
import {
  parseTodoId,
  type QuarantineItem,
  TODO_FILTERS,
  TODO_STATUSES,
  type Todo,
  type TodoFilter,
  type TodoPatch,
} from "@yarvis/shared";
import { QUARANTINE, TODOS, type SheetsStore } from "../connectors/sheets.js";
import { sendError } from "../http.js";

export const TODOS_CACHE_TTL_MS = 10_000;

/** The to-dos the list shows: none whose message has an active (released_at "") Quarantine row. */
export function visibleTodos(
  todos: readonly Todo[],
  quarantine: readonly QuarantineItem[],
): Todo[] {
  const held = new Set(quarantine.filter((q) => q.released_at === "").map((q) => q.id));
  return todos.filter((t) => {
    const messageId = parseTodoId(t.id)?.messageId;
    return messageId === undefined || !held.has(messageId);
  });
}

export class TodosCache {
  private rows: Todo[] | undefined;
  private loadedAt = 0;
  private inflight: Promise<Todo[]> | undefined;
  private generation = 0;

  constructor(
    private readonly store: SheetsStore,
    private readonly ttlMs: number = TODOS_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<Todo[]> {
    if (this.rows && this.now() - this.loadedAt < this.ttlMs) return Promise.resolve(this.rows);
    if (this.inflight) return this.inflight;
    const gen = this.generation;
    const load = Promise.all([this.store.readRows(TODOS), this.store.readRows(QUARANTINE)]).then(
      ([todos, quarantine]) => {
        const rows = visibleTodos(todos, quarantine);
        // A PATCH that landed while this read was in flight invalidated it: do not cache it.
        if (gen === this.generation) {
          this.rows = rows;
          this.loadedAt = this.now();
        }
        if (this.inflight === load) this.inflight = undefined;
        return rows;
      },
      (err: unknown) => {
        if (this.inflight === load) this.inflight = undefined;
        throw err;
      },
    );
    this.inflight = load;
    return load;
  }

  invalidate(): void {
    this.generation++;
    this.rows = undefined;
    this.inflight = undefined;
  }
}

const TodoPatchSchema = z.strictObject({ status: z.enum(TODO_STATUSES) });

function parseFilter(raw: unknown): TodoFilter | null {
  if (raw === undefined) return "open";
  return typeof raw === "string" && (TODO_FILTERS as readonly string[]).includes(raw)
    ? (raw as TodoFilter)
    : null;
}

export function todosRouter(opts: {
  store: SheetsStore;
  cache: TodosCache;
  /** ISO timestamp for `updated_at` (injectable for tests). */
  nowIso?: () => string;
}): Router {
  const { store, cache } = opts;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const router = Router();

  router.get("/api/todos", async (req, res) => {
    const filter = parseFilter(req.query.status);
    if (!filter) {
      sendError(res, "bad_request", `status must be one of ${TODO_FILTERS.join(", ")}`);
      return;
    }
    const rows = await cache.get();
    const body: Todo[] = filter === "all" ? rows : rows.filter((t) => t.status === filter);
    res.json(body);
  });

  router.patch("/api/todos/:id", async (req, res) => {
    const id = req.params.id;
    if (!parseTodoId(id)) {
      sendError(res, "bad_id", "not a todo id (<message id>#<n>)");
      return;
    }
    const parsed = TodoPatchSchema.safeParse(req.body as unknown);
    if (!parsed.success) {
      sendError(res, "bad_request", `body must be {status: ${TODO_STATUSES.join(" | ")}}`);
      return;
    }
    const patch: TodoPatch = parsed.data;
    const updated = await store.updateRow(TODOS, id, {
      status: patch.status,
      updated_at: nowIso(),
    });
    if (!updated) {
      sendError(res, "not_found", "no todo with that id in the Todos tab");
      return;
    }
    cache.invalidate();
    res.json(updated);
  });

  return router;
}
