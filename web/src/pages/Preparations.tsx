// Saved preparations list (plan Phase 2 / S1, Step 11): the 100 most recently updated packets
// (GET /api/assistant/preparations), each with its local state and updated time, opening
// /preparations/:id. When more exist the total and a limit notice are shown (no silent truncation);
// older packets stay reachable through their saved id link. Plain React text only.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { PacketListResponse } from "@yarvis/shared";
import { api, ApiError } from "../api.js";
import { usePirate } from "../i18n/strings.js";
import { fill, formatDate } from "../ui/format.js";

type Load =
  | { kind: "loading" }
  | { kind: "ok"; list: PacketListResponse }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function PreparationsPage() {
  const t = usePirate();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    api
      .listPackets()
      .then((list) => {
        if (!cancelled) setLoad({ kind: "ok", list });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.apiCode === "assistant_unavailable") {
          setLoad({ kind: "unavailable" });
        } else {
          setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="preparations" data-testid="preparations-page">
      <h1>{t.prepListTitle}</h1>
      {load.kind === "loading" && <p className="muted">{t.loading}</p>}
      {load.kind === "unavailable" && (
        <p role="alert" className="error" data-testid="assistant-unavailable">
          {t.assistantUnavailable} <Link to="/todos">{t.briefingGoTodos}</Link>
        </p>
      )}
      {load.kind === "error" && (
        <p role="alert" className="error" data-testid="preparations-error">
          {t.prepListError}: {load.message}
        </p>
      )}
      {load.kind === "ok" && <PacketList list={load.list} />}
    </section>
  );
}

function PacketList({ list }: { list: PacketListResponse }) {
  const t = usePirate();
  if (list.total === 0) {
    return (
      <p className="muted" data-testid="preparations-empty">
        {t.prepListEmpty} <Link to="/briefing">{t.navBriefing}</Link>
      </p>
    );
  }
  return (
    <>
      <p className="muted" data-testid="preparations-total">
        {fill(t.prepListTotal, { total: list.total })}
      </p>
      {list.omittedCount > 0 && (
        <p className="tag tag-historical" data-testid="preparations-omitted">
          {fill(t.prepListOmitted, { shown: list.packets.length, total: list.total })}
        </p>
      )}
      <ul className="todos preparations-list" data-testid="preparations-list">
        {list.packets.map((p) => (
          <li
            key={p.id}
            className="todo preparations-item"
            data-testid="preparations-item"
            data-packet-id={p.id}
            data-state={p.state}
          >
            <div className="todo-main">
              <span
                className={`tag preparation-state preparation-state-${p.state}`}
                data-testid="preparations-state"
              >
                {p.state === "handled" ? t.prepStateHandled : t.prepStateOpen}
              </span>
              <Link
                to={`/preparations/${p.id}`}
                className="preparations-open"
                data-testid="preparations-open"
              >
                {p.context === "" ? p.todoId : p.context}
              </Link>
            </div>
            <div className="todo-meta muted" data-testid="preparations-updated">
              {fill(t.prepUpdated, { date: formatDate(p.updatedAt), revision: p.revision })}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
