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
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { AssistantRun, Briefing, RunErrorCode } from "@yarvis/shared";
import { api, ApiError } from "../api.js";
import { pollAssistantRun, startOrRecover } from "../assistant-poll.js";
import { usePirate, type StringKey, type Strings } from "../i18n/strings.js";
import { fill, formatAge, formatDate, safeHref } from "../ui/format.js";

const RUN_ERROR_LABEL: Readonly<Record<RunErrorCode, StringKey>> = {
  source_unavailable: "errSourceUnavailable",
  sheets_not_configured: "errSheetsNotConfigured",
  run_timeout: "errRunTimeout",
  shutdown: "errShutdown",
  abandoned: "errAbandoned",
  compose_timeout: "errRunTimeout",
  compose_invalid: "errInternal",
  compose_failed: "errInternal",
  internal: "errInternal",
};

/** Re-render often enough that the snapshot age stays truthful. */
const AGE_TICK_MS = 30_000;

type Problem =
  { kind: "busy" } | { kind: "lost" } | { kind: "start" | "status" | "load"; message: string };

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

function BriefingView({
  briefing,
  run,
  now,
  t,
}: {
  briefing: Briefing;
  run: AssistantRun | null;
  now: number;
  t: Strings;
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
        setRun(latestRun);
        setBriefing(latestBriefing);
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
    };
  }, [watch]);

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
    if (next.state === "succeeded") {
      showSucceeded(next);
      return;
    }
    setRun(next);
    if (next.state === "running") watch(next.id);
  };

  const running = starting || run?.state === "running";
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
            disabled={running || briefing === undefined}
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
      {briefing && <BriefingView briefing={briefing} run={run} now={now} t={t} />}
    </section>
  );
}
