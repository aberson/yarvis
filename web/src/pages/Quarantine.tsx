// Quarantine page (plan §5, G4): every Quarantine-tab row with its reason, Jev scores and link.
// Released rows (released_at set, D16) stay listed and are marked.
import { useEffect, useState } from "react";
import type { QuarantineItem } from "@yarvis/shared";
import { api } from "../api.js";
import { usePirate } from "../i18n/strings.js";
import { formatDate, formatReason, formatScore, safeHref } from "../ui/format.js";

export function QuarantinePage() {
  const t = usePirate();
  const [items, setItems] = useState<QuarantineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getQuarantine()
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1>{t.navQuarantine}</h1>
      <p className="muted">{t.quarantineIntro}</p>
      {error && (
        <p role="alert" className="error">
          {t.quarantineLoadError}: {error}
        </p>
      )}
      {items === null && !error && <p className="muted">{t.loading}</p>}
      {items !== null && items.length === 0 && <p className="muted">{t.quarantineEmpty}</p>}
      {items !== null && items.length > 0 && (
        <div className="table-wrap">
          <table className="quarantine" data-testid="quarantine-table">
            <thead>
              <tr>
                <th>{t.colSource}</th>
                <th>{t.colSender}</th>
                <th>{t.colContext}</th>
                <th>{t.colDate}</th>
                <th className="reason">{t.colReason}</th>
                <th className="num">{t.colPhishing}</th>
                <th className="num">{t.colMalicious}</th>
                <th className="num">{t.colSpam}</th>
                <th>{t.colLink}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => {
                const href = safeHref(q.link);
                return (
                  <tr
                    key={q.id}
                    data-testid="quarantine-row"
                    data-quarantine-id={q.id}
                    className={q.released_at ? "released" : undefined}
                  >
                    <td>
                      <span className={`chip chip-${q.source}`}>
                        {q.source === "gmail" ? t.sourceGmail : t.sourceWhatsapp}
                      </span>
                    </td>
                    <td>{q.sender}</td>
                    <td>{q.context}</td>
                    <td>{formatDate(q.message_date)}</td>
                    <td className="reason" data-testid="quarantine-reason">
                      {formatReason(q.reason)}
                      {q.released_at && <span className="tag">{t.released}</span>}
                    </td>
                    <td className="num" data-testid="score-phishing">
                      {formatScore(q.jev_phishing, t.noScore)}
                    </td>
                    <td className="num" data-testid="score-malicious">
                      {formatScore(q.jev_malicious, t.noScore)}
                    </td>
                    <td className="num" data-testid="score-spam">
                      {formatScore(q.jev_spam, t.noScore)}
                    </td>
                    <td className="link">
                      {href && (
                        <a href={href} target="_blank" rel="noreferrer">
                          {t.openOriginal}
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
