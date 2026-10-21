// Preparation page (plan Phase 2 / S1, Step 10): one saved preparation packet, opened by its id from
// the Briefing. Read-only in this step (editing, saving and "handled" arrive in Step 11).
//   - Everything is rendered as plain React text (no HTML injection); only the original link, after
//     safeHref, becomes an anchor.
//   - It says plainly that the draft is never sent, and that the source is the stored excerpt the
//     packet was generated from (its capture date), not a claim about current eligibility.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { PreparationPacket } from "@yarvis/shared";
import { api, ApiError } from "../api.js";
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
      <p>
        <Link to="/briefing" data-testid="preparation-back">
          {t.prepBack}
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
      {load.kind === "ok" && <PacketView packet={load.packet} />}
    </section>
  );
}

function PacketView({ packet }: { packet: PreparationPacket }) {
  const t = usePirate();
  const ref = packet.sourceRef;
  const href = safeHref(ref.link);
  return (
    <div
      data-testid="preparation"
      data-packet-id={packet.id}
      data-todo-id={packet.todoId}
      data-revision={packet.revision}
      data-state={packet.state}
    >
      <p className="tag" data-testid="preparation-not-sent">
        {t.prepNotSent}
      </p>
      <p className="muted" data-testid="preparation-meta">
        {fill(t.prepMeta, {
          date: formatDate(packet.createdAt),
          model: packet.model,
          prompt: packet.promptVersion,
        })}
      </p>

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
      </div>

      <h2>{t.prepDraft}</h2>
      {packet.draft === "" ? (
        <p className="muted" data-testid="preparation-draft-empty">
          {t.prepDraftEmpty}
        </p>
      ) : (
        <p className="preparation-text preparation-draft" data-testid="preparation-draft">
          {packet.draft}
        </p>
      )}

      <h2>{t.prepChecklist}</h2>
      <ul className="preparation-checklist" data-testid="preparation-checklist">
        {packet.checklist.map((c) => (
          <li key={c.id} data-testid="preparation-check" data-done={c.done}>
            <label>
              <input type="checkbox" checked={c.done} disabled readOnly /> <span>{c.text}</span>
            </label>
          </li>
        ))}
      </ul>

      <h2>{t.prepQuestions}</h2>
      {packet.questions.length === 0 ? (
        <p className="muted" data-testid="preparation-no-questions">
          {t.prepNoQuestions}
        </p>
      ) : (
        <ul className="preparation-questions" data-testid="preparation-questions">
          {packet.questions.map((q, i) => (
            <li key={i} data-testid="preparation-question">
              {q}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
