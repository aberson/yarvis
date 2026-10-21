// Preparation page (plan Phase 2 / S1, Steps 10-11): one saved preparation packet, opened by its id
// from the Briefing or the saved-preparations list, and edited in place.
//   - Everything is rendered as plain React text / form values (no HTML injection); only the
//     original link, after safeHref, becomes an anchor.
//   - It says plainly that the draft is never sent, and that the source is the stored capture the
//     packet was generated from (its capture date), not a claim about current eligibility.
//   - Editing (Step 11): the draft, each checklist item's text and done box, and the questions
//     (add/remove within the bounds) are edited locally. Checklist items are edited or ticked off
//     in place (never added/removed) so their stable ids survive. Save sends the full content with
//     the revision it was based on (compare-and-swap). "Mark handled" / "Reopen" save the same way
//     with the new local state; handled never changes the Todo (the Todos link is the separate action).
//   - Unsaved edits are never discarded silently: the page shows an unsaved-changes state, warns on
//     reload/close (beforeunload) and on in-app navigation (useBlocker), keeps local text on every
//     failed save, and on a 409 conflict shows the saved version for review with an explicit
//     "keep my edits" / "load saved version" choice. Nothing regenerates over edits.
import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router";
import {
  CHECKLIST_ITEM_MAX_CHARS,
  DRAFT_MAX_CHARS,
  QUESTION_MAX_CHARS,
  QUESTIONS_MAX_ITEMS,
  type ChecklistItem,
  type PacketState,
  type PreparationPacket,
} from "@yarvis/shared";
import { api, ApiError, conflictPacket, isLostResponse } from "../api.js";
import { usePirate } from "../i18n/strings.js";
import { fill, formatDate, safeHref } from "../ui/format.js";

type Load =
  | { kind: "loading" }
  | { kind: "ok"; packet: PreparationPacket }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function PreparationPage() {
  const t = usePirate();
  const { id = "" } = useParams();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    api
      .getPacket(id)
      .then((packet) => {
        if (!cancelled) setLoad({ kind: "ok", packet });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.apiCode === "not_found" || err.apiCode === "bad_id")) {
          setLoad({ kind: "not_found" });
        } else if (err instanceof ApiError && err.apiCode === "assistant_unavailable") {
          setLoad({ kind: "unavailable" });
        } else {
          setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <section className="preparation" data-testid="preparation-page">
      <p className="row preparation-nav">
        <Link to="/briefing" data-testid="preparation-back">
          {t.prepBack}
        </Link>
        <Link to="/preparations" data-testid="preparation-list-link">
          {t.prepListTitle}
        </Link>
      </p>
      <h1>{t.prepTitle}</h1>
      {load.kind === "loading" && <p className="muted">{t.loading}</p>}
      {load.kind === "not_found" && (
        <p role="alert" className="error" data-testid="preparation-not-found">
          {t.prepNotFound}
        </p>
      )}
      {load.kind === "unavailable" && (
        <p role="alert" className="error" data-testid="assistant-unavailable">
          {t.assistantUnavailable} <Link to="/todos">{t.briefingGoTodos}</Link>
        </p>
      )}
      {load.kind === "error" && (
        <p role="alert" className="error" data-testid="preparation-error">
          {t.prepLoadError}: {load.message}
        </p>
      )}
      {load.kind === "ok" && <PacketEditor key={load.packet.id} initial={load.packet} />}
    </section>
  );
}

/** The editable content of a packet (state is saved by its own explicit action). */
interface Edit {
  draft: string;
  checklist: ChecklistItem[];
  questions: string[];
}

function editOf(p: Edit): Edit {
  return {
    draft: p.draft,
    checklist: p.checklist.map((c) => ({ id: c.id, text: c.text, done: c.done })),
    questions: [...p.questions],
  };
}

function sameEdit(a: Edit, b: Edit): boolean {
  return JSON.stringify(editOf(a)) === JSON.stringify(editOf(b));
}

/** Mirrors the server's bounds (non-blank list entries) so an obvious slip never round-trips. */
function editIsValid(e: Edit): boolean {
  return (
    e.checklist.every((c) => c.text.trim() !== "") && e.questions.every((q) => q.trim() !== "")
  );
}

function PacketEditor({ initial }: { initial: PreparationPacket }) {
  const t = usePirate();
  /** The last version known to be saved: the base revision of the next save. */
  const [saved, setSaved] = useState(initial);
  const [edit, setEdit] = useState<Edit>(() => editOf(initial));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The newer saved version a stale save ran into (409), shown for review. */
  const [conflict, setConflict] = useState<PreparationPacket | null>(null);
  const dirty = !sameEdit(edit, saved);
  /**
   * A save whose response was lost (network/proxy failure): the server may have committed it. A
   * later 409 carrying exactly that write one revision on is our own save, not another tab's.
   */
  const unacked = useRef<{ sent: Edit; state: PacketState; base: number } | null>(null);
  /** Client-only keys for the (id-less) questions so removing one never shifts focus/DOM rows. */
  const nextKey = useRef(0);
  const freshKeys = (n: number) => Array.from({ length: n }, () => nextKey.current++);
  const [qKeys, setQKeys] = useState<number[]>(() => freshKeys(initial.questions.length));

  // Reload / tab close with unsaved edits: the browser's own leave prompt.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // In-app navigation with unsaved edits: an explicit stay / leave choice.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  /**
   * `target` is the state to save: an explicit "Mark handled" / "Reopen" passes it, a plain Save
   * passes "keep" (the saved state). After re-basing onto our own lost-but-committed save, "keep"
   * follows THAT save's state, so a lost "Mark handled" is never silently reopened by a later Save.
   */
  async function save(target: PacketState | "keep"): Promise<void> {
    if (saving || conflict) return;
    if (!editIsValid(edit)) {
      setSaveError(t.prepSaveInvalid);
      return;
    }
    const sent = editOf(edit);
    setSaving(true);
    setSaveError(null);
    let base = saved;
    let state = target === "keep" ? saved.state : target;
    try {
      // At most one silent re-base: when the 409 is our own earlier, unacknowledged save.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const next = await api.savePacket(base.id, {
            expectedRevision: base.revision,
            ...sent,
            state,
          });
          unacked.current = null;
          setSaved(next);
          // Text typed while the save was in flight stays local (and dirty).
          setEdit((cur) => (sameEdit(cur, sent) ? editOf(next) : cur));
          return;
        } catch (err) {
          const current = conflictPacket(err);
          const pending = unacked.current;
          if (current && sameEdit(current, sent) && current.state === state) {
            // Our own earlier save landed but its response was lost: nothing to resolve.
            unacked.current = null;
            setSaved(current);
          } else if (
            current &&
            attempt === 0 &&
            pending &&
            current.revision === pending.base + 1 &&
            current.state === pending.state &&
            sameEdit(current, pending.sent)
          ) {
            // The lost save committed; these newer edits build on it.
            unacked.current = null;
            base = current;
            setSaved(current);
            if (target === "keep") state = current.state;
            continue;
          } else if (current) {
            setConflict(current);
          } else if (err instanceof ApiError && err.apiCode === "bad_request") {
            setSaveError(t.prepSaveInvalid);
          } else {
            if (isLostResponse(err)) unacked.current = { sent, state, base: base.revision };
            setSaveError(err instanceof Error ? err.message : String(err));
          }
          return;
        }
      }
    } finally {
      setSaving(false);
    }
  }

  function keepMine(): void {
    if (!conflict) return;
    // The next save is based on the newer revision; local edits stay (and stay unsaved).
    setSaved(conflict);
    setConflict(null);
  }

  function loadTheirs(): void {
    if (!conflict) return;
    setSaved(conflict);
    setEdit(editOf(conflict));
    setQKeys(freshKeys(conflict.questions.length));
    setConflict(null);
  }

  const ref = saved.sourceRef;
  const href = safeHref(ref.link);
  const handled = saved.state === "handled";
  const locked = saving || conflict !== null;

  return (
    <div
      data-testid="preparation"
      data-packet-id={saved.id}
      data-todo-id={saved.todoId}
      data-revision={saved.revision}
      data-state={saved.state}
      data-dirty={dirty}
    >
      <p className="tag" data-testid="preparation-not-sent">
        {t.prepNotSent}
      </p>
      <p className="muted" data-testid="preparation-meta">
        {fill(t.prepMeta, {
          date: formatDate(saved.createdAt),
          model: saved.model,
          prompt: saved.promptVersion,
        })}
      </p>
      <p className="muted" data-testid="preparation-updated">
        {fill(t.prepUpdated, { date: formatDate(saved.updatedAt), revision: saved.revision })}
      </p>

      {blocker.state === "blocked" && (
        <div className="preparation-panel" role="alertdialog" data-testid="preparation-leave">
          <p>{t.prepLeaveTitle}</p>
          <div className="row">
            <button type="button" onClick={() => blocker.reset()} data-testid="preparation-stay">
              {t.prepLeaveStay}
            </button>
            <button
              type="button"
              onClick={() => blocker.proceed()}
              data-testid="preparation-leave-go"
            >
              {t.prepLeaveGo}
            </button>
          </div>
        </div>
      )}

      <h2>{t.prepSource}</h2>
      <div className="todo preparation-source" data-testid="preparation-source">
        <div className="todo-main">
          <span className={`chip chip-${ref.source}`} data-source={ref.source}>
            {ref.source === "gmail" ? t.sourceGmail : t.sourceWhatsapp}
          </span>
          <span className="todo-action">{ref.action}</span>
        </div>
        <div className="todo-meta muted">
          <span>{ref.sender}</span>
          <span>{ref.context}</span>
          <span>{formatDate(ref.messageDate)}</span>
          {href && (
            <a href={href} target="_blank" rel="noreferrer" data-testid="preparation-link">
              {t.openOriginal}
            </a>
          )}
        </div>
        <p className="preparation-text" data-testid="preparation-excerpt">
          {ref.originalText}
        </p>
        <p className="muted">{t.prepExcerptNote}</p>
        <p className="muted" data-testid="preparation-captured">
          {fill(t.prepCaptured, { date: formatDate(saved.createdAt) })}
        </p>
      </div>

      <h2>{t.prepDraft}</h2>
      {edit.draft === "" && (
        <p className="muted" data-testid="preparation-draft-empty">
          {t.prepDraftEmpty}
        </p>
      )}
      <textarea
        className="preparation-input preparation-draft"
        data-testid="preparation-draft"
        aria-label={t.prepDraftLabel}
        rows={8}
        maxLength={DRAFT_MAX_CHARS}
        value={edit.draft}
        onChange={(e) => {
          const draft = e.target.value;
          setEdit((cur) => ({ ...cur, draft }));
        }}
      />

      <h2>{t.prepChecklist}</h2>
      <p className="muted">{t.prepChecklistNote}</p>
      <ul className="preparation-checklist" data-testid="preparation-checklist">
        {edit.checklist.map((c, i) => (
          <li key={c.id} data-testid="preparation-check" data-done={c.done}>
            <input
              type="checkbox"
              data-testid="preparation-check-done"
              aria-label={fill(t.prepItemDoneLabel, { n: i + 1 })}
              checked={c.done}
              onChange={(e) => {
                const done = e.target.checked;
                setEdit((cur) => ({
                  ...cur,
                  checklist: cur.checklist.map((x) => (x.id === c.id ? { ...x, done } : x)),
                }));
              }}
            />
            <textarea
              className="preparation-input"
              data-testid="preparation-check-text"
              aria-label={fill(t.prepItemLabel, { n: i + 1 })}
              rows={2}
              maxLength={CHECKLIST_ITEM_MAX_CHARS}
              value={c.text}
              onChange={(e) => {
                const text = e.target.value;
                setEdit((cur) => ({
                  ...cur,
                  checklist: cur.checklist.map((x) => (x.id === c.id ? { ...x, text } : x)),
                }));
              }}
            />
          </li>
        ))}
      </ul>

      <h2>{t.prepQuestions}</h2>
      {edit.questions.length === 0 && (
        <p className="muted" data-testid="preparation-no-questions">
          {t.prepNoQuestions}
        </p>
      )}
      <ul className="preparation-questions" data-testid="preparation-questions">
        {edit.questions.map((q, i) => (
          <li key={qKeys[i] ?? `q${i}`} data-testid="preparation-question">
            <textarea
              className="preparation-input"
              data-testid="preparation-question-text"
              aria-label={fill(t.prepQuestionLabel, { n: i + 1 })}
              rows={2}
              maxLength={QUESTION_MAX_CHARS}
              value={q}
              onChange={(e) => {
                const text = e.target.value;
                setEdit((cur) => ({
                  ...cur,
                  questions: cur.questions.map((x, j) => (j === i ? text : x)),
                }));
              }}
            />
            <button
              type="button"
              data-testid="preparation-question-remove"
              onClick={() => {
                setEdit((cur) => ({ ...cur, questions: cur.questions.filter((_, j) => j !== i) }));
                setQKeys((cur) => cur.filter((_, j) => j !== i));
              }}
            >
              {t.prepRemoveQuestion}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="preparation-question-add"
        disabled={edit.questions.length >= QUESTIONS_MAX_ITEMS}
        onClick={() => {
          setEdit((cur) => ({ ...cur, questions: [...cur.questions, ""] }));
          setQKeys((cur) => [...cur, ...freshKeys(1)]);
        }}
      >
        {t.prepAddQuestion}
      </button>

      {conflict && (
        <div className="preparation-panel" role="alert" data-testid="preparation-conflict">
          <h2>{t.prepConflictTitle}</h2>
          <p>
            {fill(t.prepConflictBody, {
              revision: conflict.revision,
              date: formatDate(conflict.updatedAt),
            })}
          </p>
          <h3>{t.prepConflictSaved}</h3>
          <div className="preparation-theirs" data-testid="preparation-theirs">
            <p className="tag" data-testid="preparation-theirs-state">
              {conflict.state === "handled" ? t.prepStateHandled : t.prepStateOpen}
            </p>
            <p className="preparation-text" data-testid="preparation-theirs-draft">
              {conflict.draft}
            </p>
            <ul className="preparation-checklist">
              {conflict.checklist.map((c) => (
                <li key={c.id} data-testid="preparation-theirs-check" data-done={c.done}>
                  <input type="checkbox" checked={c.done} disabled readOnly /> <span>{c.text}</span>
                </li>
              ))}
            </ul>
            <ul className="preparation-questions">
              {conflict.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </div>
          <div className="row">
            <button type="button" onClick={keepMine} data-testid="preparation-keep-mine">
              {t.prepConflictKeepMine}
            </button>
            <button type="button" onClick={loadTheirs} data-testid="preparation-load-theirs">
              {t.prepConflictLoadTheirs}
            </button>
          </div>
        </div>
      )}

      {saveError && (
        <p role="alert" className="error" data-testid="preparation-save-error">
          {t.prepSaveError}: {saveError}
        </p>
      )}

      <div className="row preparation-actions">
        <button
          type="button"
          data-testid="preparation-save"
          disabled={locked || !dirty}
          onClick={() => void save("keep")}
        >
          {saving ? t.prepSaving : t.prepSave}
        </button>
        <button
          type="button"
          data-testid="preparation-toggle-state"
          disabled={locked}
          onClick={() => void save(handled ? "open" : "handled")}
        >
          {handled ? t.prepReopen : t.prepMarkHandled}
        </button>
        <span
          className={dirty ? "tag preparation-unsaved" : "tag"}
          data-testid="preparation-status"
          data-dirty={dirty}
        >
          {saving ? t.prepSaving : dirty ? t.prepUnsaved : t.prepSaved}
        </span>
        <span
          className={`tag preparation-state preparation-state-${saved.state}`}
          data-testid="preparation-state"
        >
          {handled ? t.prepStateHandled : t.prepStateOpen}
        </span>
      </div>
      <p className="muted" data-testid="preparation-handled-note">
        {t.prepHandledNote}{" "}
        <Link to="/todos" data-testid="preparation-todos-link">
          {t.prepCompleteTodo}
        </Link>
      </p>
    </div>
  );
}
