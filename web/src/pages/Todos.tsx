// Todos page (plan §5, G1, G3, P6): combined to-do list with source chips, a done checkbox
// (PATCH /api/todos/:id), a hide-done toggle (GET /api/todos?status=open|all) and the "Open sheet"
// link. The Refresh button + stage progress arrive with the pipeline (Step 6).
import { useEffect, useRef, useState } from "react";
import { isSheetIdConfigured, sheetUrl, type SettingsResponse, type Todo } from "@yarvis/shared";
import { api } from "../api.js";
import { usePirate } from "../i18n/strings.js";
import { formatDate, safeHref } from "../ui/format.js";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  }, [hideDone]);

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
