// Todos page (plan §5, G1, G3, P6): combined to-do list with source chips, a done checkbox
// (PATCH /api/todos/:id), a hide-done toggle (GET /api/todos?status=open|all) and the "Open sheet"
// link, and the Refresh button (POST /api/refresh) with per-stage progress and error text, polled
// every 2 s while the job runs; a finished job re-reads the to-dos (Step 6, D13).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSheetIdConfigured,
  REFRESH_STAGES,
  sheetUrl,
  type RefreshStage,
  type RefreshState,
  type RefreshStatus,
  type SettingsResponse,
  type StageState,
  type Todo,
} from "@yarvis/shared";
import { api } from "../api.js";
import { usePirate, type StringKey } from "../i18n/strings.js";
import { pollRefreshStatus } from "../refresh-poll.js";
import { formatDate, safeHref } from "../ui/format.js";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const STAGE_LABEL: Readonly<Record<RefreshStage, StringKey>> = {
  whatsapp: "stageWhatsapp",
  gmail: "stageGmail",
  jev: "stageJev",
  extract: "stageExtract",
  sheets: "stageSheets",
};

const STAGE_STATE_LABEL: Readonly<Record<StageState, StringKey>> = {
  pending: "statePending",
  running: "stateRunning",
  done: "stateDone",
  error: "stateError",
  skipped: "stateSkipped",
};

const JOB_LABEL: Readonly<Record<Exclude<RefreshState, "idle">, StringKey>> = {
  running: "jobRunning",
  done: "jobDone",
  partial: "jobPartial",
  error: "jobError",
};

type RefreshProblem = { kind: "start" | "status"; message: string } | { kind: "busy" };

/** Refresh button + stage progress; `onFinished` runs when a job this page watched ends. */
function RefreshPanel({ onFinished }: { onFinished: () => void }) {
  const t = usePirate();
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<RefreshProblem | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  // False once unmounted: a Refresh click that resolves afterwards must not start polling.
  const mountedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const watch = useCallback(() => {
    stopRef.current?.();
    stopRef.current = pollRefreshStatus({
      fetchStatus: api.getRefreshStatus,
      onStatus: (s) => {
        setStatus(s);
        setProblem((p) => (p?.kind === "status" ? null : p));
      },
      onFinished: () => onFinishedRef.current(),
      onError: (err) => setProblem({ kind: "status", message: errorText(err) }),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    // Show the last job's result; resume watching a job that is still running.
    api
      .getRefreshStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.state === "running") watch();
      })
      .catch((err: unknown) => {
        if (!cancelled) setProblem({ kind: "status", message: errorText(err) });
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      stopRef.current?.();
    };
  }, [watch]);

  const start = async () => {
    setStarting(true);
    setProblem(null);
    try {
      const result = await api.startRefresh();
      if (!mountedRef.current) return;
      if (!result.started) setProblem({ kind: "busy" });
      watch();
    } catch (err) {
      if (mountedRef.current) setProblem({ kind: "start", message: errorText(err) });
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  const running = starting || status?.state === "running";
  const shown = status !== null && status.state !== "idle" ? status : null;
  const jobState = shown && shown.state !== "idle" ? shown.state : null;
  return (
    <div className="refresh" data-testid="refresh-panel">
      <div className="row">
        <button
          type="button"
          data-testid="refresh-button"
          disabled={running}
          onClick={() => void start()}
        >
          {running ? t.refreshing : t.refresh}
        </button>
        {jobState && (
          <span
            data-testid="refresh-state"
            data-state={jobState}
            className={jobState === "error" ? "error" : "muted"}
          >
            {t[JOB_LABEL[jobState]]}
          </span>
        )}
      </div>
      {problem?.kind === "busy" && (
        <p className="muted" data-testid="refresh-busy">
          {t.refreshAlreadyRunning}
        </p>
      )}
      {problem && problem.kind !== "busy" && (
        <p role="alert" className="error">
          {problem.kind === "start" ? t.refreshStartError : t.refreshStatusError}: {problem.message}
        </p>
      )}
      {shown && (
        <ol className="stages" data-testid="refresh-stages">
          {REFRESH_STAGES.map((name) => {
            const stage = shown.stages[name];
            return (
              <li
                key={name}
                data-testid="refresh-stage"
                data-stage={name}
                data-state={stage.state}
                className={`stage stage-${stage.state}`}
              >
                <span className="stage-name">{t[STAGE_LABEL[name]]}</span>
                <span className="stage-state">{t[STAGE_STATE_LABEL[stage.state]]}</span>
                {(stage.state === "done" || stage.state === "error") && (
                  <span className="stage-count" data-testid="stage-count">
                    {stage.count}
                  </span>
                )}
                {stage.error && (
                  <span className="error stage-error" data-testid="stage-error">
                    {stage.error}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {shown?.error && (
        <p className="error" data-testid="refresh-error">
          {shown.error}
        </p>
      )}
    </div>
  );
}

export function TodosPage({ settings }: { settings: SettingsResponse | null }) {
  const t = usePirate();
  const [hideDone, setHideDone] = useState(true);
  // Read by toggleDone after its PATCH resolves, so a filter flip mid-flight is honoured.
  const hideDoneRef = useRef(hideDone);
  hideDoneRef.current = hideDone;
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  // Bumped when a refresh job finishes: re-reads the to-dos (the server dropped its read cache).
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .getTodos(hideDone ? "open" : "all")
      .then((rows) => {
        if (cancelled) return;
        setTodos(rows);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [hideDone, reloadKey]);

  const toggleDone = async (todo: Todo) => {
    const status = todo.status === "done" ? "open" : "done";
    setSaving((prev) => new Set(prev).add(todo.id));
    setSaveError(null);
    try {
      const updated = await api.patchTodo(todo.id, { status });
      setTodos((prev) => {
        if (!prev) return prev;
        if (hideDoneRef.current && updated.status === "done")
          return prev.filter((x) => x.id !== updated.id);
        return prev.map((x) => (x.id === updated.id ? updated : x));
      });
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(todo.id);
        return next;
      });
    }
  };

  const sheetId = settings?.sheetId ?? "";

  return (
    <section>
      <h1>{t.navTodos}</h1>
      <RefreshPanel onFinished={reload} />
      <div className="row toolbar">
        <button
          type="button"
          data-testid="hide-done-toggle"
          aria-pressed={hideDone}
          onClick={() => setHideDone((v) => !v)}
        >
          {hideDone ? t.showDone : t.hideDone}
        </button>
        {settings === null ? null : isSheetIdConfigured(sheetId) ? (
          <a data-testid="open-sheet" href={sheetUrl(sheetId)} target="_blank" rel="noreferrer">
            {t.openSheet}
          </a>
        ) : (
          <span data-testid="open-sheet-missing" className="muted">
            {t.sheetNotConfigured}
          </span>
        )}
      </div>
      {loadError && (
        <p role="alert" className="error">
          {t.todosLoadError}: {loadError}
        </p>
      )}
      {saveError && (
        <p role="alert" className="error">
          {t.todoSaveError}: {saveError}
        </p>
      )}
      {todos === null && !loadError && <p className="muted">{t.loading}</p>}
      {todos !== null && todos.length === 0 && <p className="muted">{t.todosEmpty}</p>}
      {todos !== null && todos.length > 0 && (
        <ul className="todos" data-testid="todo-list">
          {todos.map((todo) => {
            const href = safeHref(todo.link);
            return (
              <li
                key={todo.id}
                data-testid="todo-row"
                data-todo-id={todo.id}
                className={todo.status === "done" ? "todo done" : "todo"}
              >
                <label className="todo-main">
                  <input
                    type="checkbox"
                    data-testid="todo-done"
                    aria-label={`${t.markDone}: ${todo.action}`}
                    checked={todo.status === "done"}
                    disabled={saving.has(todo.id)}
                    onChange={() => void toggleDone(todo)}
                  />
                  <span
                    className={`chip chip-${todo.source}`}
                    data-testid="source-chip"
                    data-source={todo.source}
                  >
                    {todo.source === "gmail" ? t.sourceGmail : t.sourceWhatsapp}
                  </span>
                  <span className="todo-action" data-testid="todo-action">
                    {todo.action}
                  </span>
                  {todo.extraction_status === "pending" && (
                    <span className="tag">{t.extractionPending}</span>
                  )}
                </label>
                <div className="todo-meta muted">
                  <span>{todo.sender}</span>
                  <span>{todo.context}</span>
                  <span>{formatDate(todo.message_date)}</span>
                  {href && (
                    <a href={href} target="_blank" rel="noreferrer">
                      {t.openOriginal}
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
