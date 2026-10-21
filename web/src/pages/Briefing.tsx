// Briefing page, the app landing route (plan Phase 2 / S1, Step 9, D44): a saved, on-demand snapshot
// of open, screened message tasks read from the sheet. Honest by construction:
//   - it says these are STORED tasks (Refresh on Todos checks for new messages) and always shows the
//     snapshot's age; per-source coverage shows configured/not and "freshness unknown";
//   - full open count plus the omitted count beyond the 25 shown, with a link to Todos;
//   - "New to this briefing" (never "new mail"); the first snapshot is a baseline;
//   - pending/none extractions are listed but marked not ready to prepare;
//   - a failed/interrupted latest run is shown as such and the older snapshot is labelled historical.
// On mount it reads the latest run and latest briefing and reconnects to a running run (polled every
// 2 s). A request id is generated once per Build click and reused only by an explicit Retry; reload
// never re-POSTs.
// Step 10: an eligible card has a Prepare action. Its request id is generated once per click and
// reused only to retry a LOST response; a failed/interrupted preparation offers Retry with a NEW
// id. The run is polled (same helper) and a success, or an existing packet for the same Todo (no
// model call), opens /preparations/:id. A running/failed prepare run found on mount is shown on
// its card.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { AssistantRun, Briefing, RunErrorCode } from "@yarvis/shared";
import { api, ApiError, pathId } from "../api.js";
import { pollAssistantRun, prepareOrRecover, startOrRecover } from "../assistant-poll.js";
import { usePirate, type StringKey, type Strings } from "../i18n/strings.js";
import { fill, formatAge, formatDate, safeHref } from "../ui/format.js";

const RUN_ERROR_LABEL: Readonly<Record<RunErrorCode, StringKey>> = {
  source_unavailable: "errSourceUnavailable",
  sheets_not_configured: "errSheetsNotConfigured",
  run_timeout: "errRunTimeout",
  shutdown: "errShutdown",
  abandoned: "errAbandoned",
  source_changed: "errSourceChanged",
  compose_timeout: "errComposeTimeout",
  compose_invalid: "errComposeInvalid",
  compose_failed: "errComposeFailed",
  internal: "errInternal",
};

/** Re-render often enough that the snapshot age stays truthful. */
const AGE_TICK_MS = 30_000;

type Problem =
  { kind: "busy" } | { kind: "lost" } | { kind: "start" | "status" | "load"; message: string };

/** The one preparation the page is following (the server runs one assistant run at a time). */
interface Prep {
  todoId: string;
  /** null: the POST has not answered yet (or was refused, see `problem`). */
  run: AssistantRun | null;
  problem:
    | { kind: "busy" | "lost" | "conflict" | "source" }
    | { kind: "start" | "status"; message: string }
    | null;
}

/** What the cards need to show / start a preparation. */
interface PrepControls {
  prep: Prep | null;
  /** Another run (briefing or preparation) is in progress: no new Prepare. */
  blocked: boolean;
  onPrepare: (todoId: string) => void;
}

function prepRunning(prep: Prep | null): boolean {
  return prep !== null && (prep.run?.state === "running" || (prep.run === null && !prep.problem));
}

function prepRetryable(prep: Prep): boolean {
  return prep.problem !== null || prep.run?.state === "failed" || prep.run?.state === "interrupted";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.apiCode === "assistant_unavailable";
}

function RunLine({ run, t }: { run: AssistantRun; t: Strings }) {
  if (run.state === "running") {
    return (
      <p className="muted" data-testid="briefing-run" data-state="running">
        {t.briefingBuilding}
      </p>
    );
  }
  if (run.state === "failed") {
    return (
      <p role="alert" className="error" data-testid="briefing-run" data-state="failed">
        {t.runFailed}: {t[RUN_ERROR_LABEL[run.errorCode ?? "internal"]]}
      </p>
    );
  }
  if (run.state === "interrupted") {
    return (
      <p role="alert" className="error" data-testid="briefing-run" data-state="interrupted">
        {t.runInterrupted}
      </p>
    );
  }
  return null;
}

function PrepLine({ prep, t }: { prep: Prep; t: Strings }) {
  const { run, problem } = prep;
  if (problem) {
    switch (problem.kind) {
      case "busy":
        return <p className="muted">{t.runBusy}</p>;
      case "lost":
        return <p className="error">{t.runLost}</p>;
      case "conflict":
        return <p className="error">{t.prepConflict}</p>;
      case "source":
        return <p className="error">{t.prepSourceUnavailable}</p>;
      case "start":
        return (
          <p className="error">
            {t.prepStartError}: {problem.message}
          </p>
        );
      case "status":
        return (
          <p className="error">
            {t.runStatusError}: {problem.message}
          </p>
        );
    }
  }
  if (run?.state === "failed") {
    return (
      <p className="error" data-testid="briefing-preparation-failed">
        {t.prepFailed}: {t[RUN_ERROR_LABEL[run.errorCode ?? "internal"]]}
      </p>
    );
  }
  if (run?.state === "interrupted") return <p className="error">{t.prepInterrupted}</p>;
  return null;
}

function PrepAction({
  todoId,
  controls,
  t,
}: {
  todoId: string;
  controls: PrepControls;
  t: Strings;
}) {
  const mine = controls.prep?.todoId === todoId ? controls.prep : null;
  const running = prepRunning(mine);
  const state = running ? "running" : (mine?.problem?.kind ?? mine?.run?.state ?? "idle");
  return (
    <div className="briefing-prep" data-testid="briefing-prep" data-state={state}>
      <button
        type="button"
        data-testid="briefing-prepare"
        disabled={running || controls.blocked}
        onClick={() => controls.onPrepare(todoId)}
      >
        {running ? t.preparing : mine && prepRetryable(mine) ? t.briefingRetry : t.prepare}
      </button>
      {mine && <PrepLine prep={mine} t={t} />}
    </div>
  );
}

function BriefingView({
  briefing,
  run,
  now,
  t,
  controls,
}: {
  briefing: Briefing;
  run: AssistantRun | null;
  now: number;
  t: Strings;
  controls: PrepControls;
}) {
  const current = run === null || run.kind !== "briefing" || run.targetId === briefing.id;
  return (
    <div className="briefing" data-testid="briefing" data-briefing-id={briefing.id}>
      {!current && run?.state === "running" && (
        <p className="muted" data-testid="briefing-previous">
          {t.briefingPrevious}
        </p>
      )}
      {!current && run?.state !== "running" && (
        <p className="tag tag-historical" data-testid="briefing-historical">
          {t.briefingHistorical}
        </p>
      )}
      <div className="briefing-meta row">
        <span data-testid="briefing-age" title={formatDate(briefing.createdAt)}>
          {fill(t.briefingSaved, { age: formatAge(briefing.createdAt, now, t) })} (
          {formatDate(briefing.createdAt)})
        </span>
        <span data-testid="briefing-open-count">
          {fill(t.briefingOpenCount, { n: briefing.openCount })}
        </span>
      </div>
      <ul className="coverage" aria-label={t.coverageTitle} data-testid="briefing-coverage">
        {briefing.sourceCoverage.map((c) => (
          <li key={c.source} data-source={c.source} data-configured={c.configured}>
            <span className={`chip chip-${c.source}`}>
              {c.source === "gmail" ? t.sourceGmail : t.sourceWhatsapp}
            </span>
            <span className="muted">
              {c.configured ? t.coverageConfigured : t.coverageNotConfigured} · {t.freshnessUnknown}
            </span>
          </li>
        ))}
      </ul>
      {briefing.previousBriefingId === null && briefing.items.length > 0 && (
        <p className="muted" data-testid="briefing-baseline">
          {t.briefingBaseline}
        </p>
      )}
      {briefing.previousBriefingId !== null &&
        briefing.items.length > 0 &&
        !briefing.items.some((i) => i.isNew) && (
          <p className="muted" data-testid="briefing-nothing-new">
            {t.briefingNothingNew}
          </p>
        )}
      {briefing.items.length === 0 ? (
        <p className="muted" data-testid="briefing-empty">
          {t.briefingEmpty}
        </p>
      ) : (
        <ul className="todos briefing-items" data-testid="briefing-items">
          {briefing.items.map(({ sourceRef: ref, isNew, preparationEligible }) => {
            const href = safeHref(ref.link);
            return (
              <li
                key={ref.todoId}
                className="todo briefing-item"
                data-testid="briefing-item"
                data-todo-id={ref.todoId}
                data-new={isNew}
                data-eligible={preparationEligible}
              >
                <div className="todo-main">
                  <span className={`chip chip-${ref.source}`} data-source={ref.source}>
                    {ref.source === "gmail" ? t.sourceGmail : t.sourceWhatsapp}
                  </span>
                  <span className="todo-action">{ref.action}</span>
                  {isNew && (
                    <span className="tag tag-new" data-testid="briefing-new">
                      {t.briefingNew}
                    </span>
                  )}
                  {ref.extractionStatus === "pending" && (
                    <span className="tag">{t.extractionPending}</span>
                  )}
                  {ref.extractionStatus === "none" && (
                    <span className="tag">{t.extractionNone}</span>
                  )}
                  {!preparationEligible && (
                    <span className="tag tag-off" data-testid="briefing-not-ready">
                      {t.briefingNotReady}
                    </span>
                  )}
                </div>
                <div className="todo-meta muted">
                  <span>{ref.sender}</span>
                  <span>{ref.context}</span>
                  <span>{formatDate(ref.messageDate)}</span>
                  {href && (
                    <a href={href} target="_blank" rel="noreferrer">
                      {t.openOriginal}
                    </a>
                  )}
                </div>
                {preparationEligible && (
                  <PrepAction todoId={ref.todoId} controls={controls} t={t} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {briefing.omittedCount > 0 && (
        <p className="muted" data-testid="briefing-omitted">
          {fill(t.briefingOmitted, { n: briefing.omittedCount })}{" "}
          <Link to="/todos" data-testid="briefing-see-all">
            {t.briefingSeeAll}
          </Link>
        </p>
      )}
    </div>
  );
}

export function BriefingPage() {
  const t = usePirate();
  // undefined: still loading.
  const [briefing, setBriefing] = useState<Briefing | null | undefined>(undefined);
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** The request id of an unanswered POST, reused ONLY by an explicit Retry. */
  const pendingRef = useRef<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(false);
  const navigate = useNavigate();
  const [prep, setPrep] = useState<Prep | null>(null);
  /** The unanswered (lost) preparation request: its id is reused ONLY to retry that response. */
  const prepPendingRef = useRef<{ todoId: string; requestId: string } | null>(null);
  const prepStopRef = useRef<(() => void) | null>(null);

  const openPacket = useCallback(
    (packetId: string) => {
      void navigate(`/preparations/${pathId(packetId)}`);
    },
    [navigate],
  );

  /** Follows a prepare run until it ends; a success opens its packet. */
  const watchPrep = useCallback(
    (todoId: string, runId: string) => {
      prepStopRef.current?.();
      prepStopRef.current = pollAssistantRun({
        runId,
        fetchRun: api.getRun,
        onRun: (r) => setPrep({ todoId, run: r, problem: null }),
        onFinished: (r) => {
          if (r.state === "succeeded" && r.targetId && mountedRef.current) openPacket(r.targetId);
        },
        onError: (err) => {
          // Permanent answers stop polling; transient ones are shown and polling continues.
          if (isUnavailable(err)) {
            prepStopRef.current?.();
            setUnavailable(true);
          } else if (err instanceof ApiError && err.apiCode === "not_found") {
            prepStopRef.current?.();
            setPrep({ todoId, run: null, problem: { kind: "status", message: errorText(err) } });
          } else {
            setPrep((p) => ({
              todoId,
              run: p?.todoId === todoId ? p.run : null,
              problem: { kind: "status", message: errorText(err) },
            }));
          }
        },
      });
    },
    [openPacket],
  );

  /** A prepare run seen outside a Prepare click (on mount, or as the busy run): show it. */
  const adoptPrep = useCallback(
    (r: AssistantRun) => {
      if (r.kind !== "prepare" || r.sourceTodoId === null || r.state === "succeeded") return;
      setPrep({ todoId: r.sourceTodoId, run: r, problem: null });
      if (r.state === "running") watchPrep(r.sourceTodoId, r.id);
    },
    [watchPrep],
  );

  /**
   * A run succeeded: read its snapshot, then show run + snapshot TOGETHER, so the old snapshot is
   * never briefly labelled historical. If the read fails the old one stays, honestly labelled.
   */
  const showSucceeded = useCallback((done: AssistantRun) => {
    api
      .getLatestBriefing()
      .then((b) => {
        if (!mountedRef.current) return;
        setBriefing(b);
        setRun(done);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setRun(done);
        if (isUnavailable(err)) setUnavailable(true);
        else setProblem({ kind: "load", message: errorText(err) });
      });
  }, []);

  const watch = useCallback(
    (runId: string) => {
      stopRef.current?.();
      stopRef.current = pollAssistantRun({
        runId,
        fetchRun: api.getRun,
        onRun: (r) => {
          if (r.state !== "succeeded") setRun(r);
          setProblem((p) => (p?.kind === "status" ? null : p));
        },
        onFinished: (r) => {
          if (r.state === "succeeded") showSucceeded(r);
        },
        onError: (err) => {
          // Permanent answers stop polling; transient ones are shown and polling continues.
          if (isUnavailable(err)) {
            stopRef.current?.();
            setUnavailable(true);
          } else if (err instanceof ApiError && err.apiCode === "not_found") {
            stopRef.current?.();
            setRun(null);
            setProblem({ kind: "status", message: errorText(err) });
          } else {
            setProblem({ kind: "status", message: errorText(err) });
          }
        },
      });
    },
    [showSucceeded],
  );

  useEffect(() => {
    mountedRef.current = true;
    Promise.all([api.getLatestRun(), api.getLatestBriefing()])
      .then(([latestRun, latestBriefing]) => {
        if (!mountedRef.current) return;
        setBriefing(latestBriefing);
        if (latestRun?.kind === "prepare") {
          adoptPrep(latestRun);
          return;
        }
        setRun(latestRun);
        if (latestRun?.state === "running") watch(latestRun.id);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setBriefing(null);
        if (isUnavailable(err)) setUnavailable(true);
        else setProblem({ kind: "load", message: errorText(err) });
      });
    const tick = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(tick);
      stopRef.current?.();
      prepStopRef.current?.();
    };
  }, [watch, adoptPrep]);

  const build = async () => {
    // One id per intentional action; a pending (unanswered) one is reused by Retry.
    const requestId = pendingRef.current ?? crypto.randomUUID();
    pendingRef.current = requestId;
    setStarting(true);
    setProblem(null);
    const outcome = await startOrRecover(requestId, {
      start: api.startBriefing,
      latestRun: api.getLatestRun,
    });
    if (!mountedRef.current) return;
    setStarting(false);
    if (outcome.kind === "lost") {
      setProblem({ kind: "lost" });
      return;
    }
    pendingRef.current = null;
    if (outcome.kind === "error") {
      if (isUnavailable(outcome.error)) setUnavailable(true);
      else setProblem({ kind: "start", message: errorText(outcome.error) });
      return;
    }
    if (outcome.kind === "busy") setProblem({ kind: "busy" });
    const next = outcome.run;
    if (!next) return;
    if (next.kind === "prepare") {
      adoptPrep(next);
      return;
    }
    if (next.state === "succeeded") {
      showSucceeded(next);
      return;
    }
    setRun(next);
    if (next.state === "running") watch(next.id);
  };

  const prepare = async (todoId: string) => {
    if (!briefing) return;
    // One id per intentional click; only a lost (unanswered) request for this card reuses its id.
    const pending = prepPendingRef.current;
    const requestId =
      pending?.todoId === todoId && prep?.todoId === todoId && prep.problem?.kind === "lost"
        ? pending.requestId
        : crypto.randomUUID();
    prepPendingRef.current = { todoId, requestId };
    prepStopRef.current?.();
    setPrep({ todoId, run: null, problem: null });
    const outcome = await prepareOrRecover(requestId, {
      start: (id) => api.startPreparation({ requestId: id, briefingId: briefing.id, todoId }),
      latestRun: api.getLatestRun,
    });
    if (!mountedRef.current) return;
    if (outcome.kind === "lost") {
      setPrep({ todoId, run: null, problem: { kind: "lost" } });
      return;
    }
    prepPendingRef.current = null;
    if (outcome.kind === "packet") {
      openPacket(outcome.packet.id);
      return;
    }
    if (outcome.kind === "error") {
      const code = outcome.error.apiCode;
      if (code === "assistant_unavailable") {
        setPrep(null);
        setUnavailable(true);
      } else if (code === "revision_conflict") {
        setPrep({ todoId, run: null, problem: { kind: "conflict" } });
      } else if (code === "source_unavailable") {
        setPrep({ todoId, run: null, problem: { kind: "source" } });
      } else {
        const message = errorText(outcome.error);
        setPrep({ todoId, run: null, problem: { kind: "start", message } });
      }
      return;
    }
    if (outcome.kind === "busy") {
      setPrep({ todoId, run: null, problem: { kind: "busy" } });
      return;
    }
    const next = outcome.run;
    if (next.state === "succeeded" && next.targetId) {
      openPacket(next.targetId);
      return;
    }
    setPrep({ todoId, run: next, problem: null });
    if (next.state === "running") watchPrep(todoId, next.id);
  };

  const preparing = prepRunning(prep);
  const running = starting || run?.state === "running";
  const controls: PrepControls = {
    prep,
    blocked: running || preparing,
    onPrepare: (todoId) => void prepare(todoId),
  };
  return (
    <section>
      <h1>{t.navBriefing}</h1>
      <p className="muted" data-testid="briefing-stored-note">
        {t.briefingStoredNote} <Link to="/todos">{t.briefingGoTodos}</Link>
      </p>
      {unavailable ? (
        <p role="alert" className="error" data-testid="assistant-unavailable">
          {t.assistantUnavailable} <Link to="/todos">{t.briefingGoTodos}</Link>
        </p>
      ) : (
        <div className="row toolbar">
          <button
            type="button"
            data-testid="briefing-generate"
            disabled={running || preparing || briefing === undefined}
            onClick={() => void build()}
          >
            {running
              ? t.briefingBuilding
              : problem?.kind === "lost"
                ? t.briefingRetry
                : t.briefingGenerate}
          </button>
        </div>
      )}
      {problem?.kind === "busy" && (
        <p className="muted" data-testid="briefing-busy">
          {t.runBusy}
        </p>
      )}
      {problem?.kind === "lost" && (
        <p role="alert" className="error" data-testid="briefing-lost">
          {t.runLost}
        </p>
      )}
      {problem &&
        (problem.kind === "start" || problem.kind === "status" || problem.kind === "load") && (
          <p role="alert" className="error" data-testid="briefing-error">
            {problem.kind === "start"
              ? t.runStartError
              : problem.kind === "status"
                ? t.runStatusError
                : t.briefingLoadError}
            : {problem.message}
          </p>
        )}
      {run && !unavailable && <RunLine run={run} t={t} />}
      {briefing === undefined && !unavailable && <p className="muted">{t.loading}</p>}
      {briefing === null && !unavailable && run?.state !== "running" && (
        <p className="muted" data-testid="briefing-none">
          {t.briefingNone}
        </p>
      )}
      {briefing && (
        <BriefingView briefing={briefing} run={run} now={now} t={t} controls={controls} />
      )}
    </section>
  );
}
