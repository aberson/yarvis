// Controls page, Connections section (plan §5, §6, D24, D40): one card per seam from GET
// /api/status, showing whether it is configured (files / env present; no live probe) and its last
// refresh success and error. The error text is the server's fixed phrase, shown as-is. Live checks
// are `yarvis doctor`.
import { useEffect, useState } from "react";
import { SEAMS, type Seam, type StatusResponse } from "@yarvis/shared";
import { api } from "../api.js";
import { usePirate, type StringKey } from "../i18n/strings.js";
import { formatDate } from "../ui/format.js";

const SEAM_LABEL: Readonly<Record<Seam, StringKey>> = {
  gmail: "seamGmail",
  whatsapp: "seamWhatsapp",
  sheets: "seamSheets",
  jev: "seamJev",
  claude: "seamClaude",
};

/** A command, not UI text: identical in every string table. */
const DOCTOR_COMMAND = "npm run yarvis -- doctor";

export function ConnectionsSection() {
  const t = usePirate();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      api
        .getStatus()
        .then((s) => {
          if (!cancelled) {
            setStatus(s);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    // A refresh finishing elsewhere (another tab, `yarvis refresh`) shows up when the page regains focus.
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, []);

  return (
    <section aria-labelledby="connections-title">
      <h2 id="connections-title">{t.connectionsTitle}</h2>
      <p className="muted">
        {t.appsIntro} <code>{DOCTOR_COMMAND}</code>
      </p>
      {error && (
        <p role="alert" className="error">
          {t.appsLoadError}: {error}
        </p>
      )}
      {status === null && !error && <p className="muted">{t.loading}</p>}
      {status !== null && (
        <ul className="cards">
          {SEAMS.map((seam) => {
            const s = status[seam];
            return (
              <li
                key={seam}
                className="card"
                data-testid="app-card"
                data-seam={seam}
                data-configured={String(s.configured)}
              >
                <h3>{t[SEAM_LABEL[seam]]}</h3>
                <span
                  className={`tag ${s.configured ? "tag-ok" : "tag-off"}`}
                  data-testid="app-configured"
                >
                  {s.configured ? t.appsConfigured : t.appsNotConfigured}
                </span>
                <dl>
                  <dt>{t.appsLastSuccess}</dt>
                  <dd data-testid="app-last-success">
                    {s.lastSuccessAt ? formatDate(s.lastSuccessAt) : t.appsNever}
                  </dd>
                  <dt>{t.appsLastError}</dt>
                  <dd data-testid="app-last-error" className={s.lastError ? "error" : undefined}>
                    {s.lastError ?? t.appsNone}
                  </dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
