// Controls page (plan §5, D39, D40): the former Connected apps and Settings pages in one. Look and
// feel (pirate toggle and logo picker, both PATCH /api/settings), the connection cards, read-only
// thresholds, and the resolved private dir path.
import { useState } from "react";
import {
  LOGO_IDS,
  type LogoId,
  type Settings,
  type SettingsPatch,
  type SettingsResponse,
} from "@yarvis/shared";
import { api } from "../api.js";
import { usePirate } from "../i18n/strings.js";
import { LOGO_NAME, Logo } from "../ui/logos.js";
import { ConnectionsSection } from "./Connections.js";

export function ControlsPage({
  settings,
  onChange,
}: {
  settings: SettingsResponse | null;
  onChange: (next: Settings) => void;
}) {
  const t = usePirate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: SettingsPatch) => {
    setSaving(true);
    setError(null);
    try {
      onChange(await api.patchSettings(patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="controls">
      <h1>{t.navControls}</h1>
      <section aria-labelledby="appearance-title" className="panel">
        <h2 id="appearance-title">{t.appearanceTitle}</h2>
        {!settings ? (
          <p className="muted">{t.loading}</p>
        ) : (
          <>
            <div className="row">
              <span id="pirate-label">{t.pirateLabel}</span>
              <button
                type="button"
                data-testid="pirate-toggle"
                aria-labelledby="pirate-label"
                aria-pressed={settings.pirate}
                disabled={saving}
                onClick={() => void save({ pirate: !settings.pirate })}
              >
                {saving ? t.saving : settings.pirate ? t.pirateOn : t.pirateOff}
              </button>
              <span className="muted">{t.pirateHint}</span>
            </div>
            <h3 id="logo-label">{t.logoLabel}</h3>
            <p className="muted">{t.logoHint}</p>
            <div className="logo-grid" role="radiogroup" aria-labelledby="logo-label">
              {LOGO_IDS.map((id: LogoId) => {
                const checked = settings.logo === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className={`logo-choice${checked ? " selected" : ""}`}
                    data-testid="logo-choice"
                    data-logo={id}
                    disabled={saving}
                    onClick={() => {
                      if (!checked) void save({ logo: id });
                    }}
                  >
                    <Logo id={id} size={64} />
                    <span>{t[LOGO_NAME[id]]}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {t.saveError}: {error}
          </p>
        )}
      </section>
      <ConnectionsSection />
      {settings && (
        <section aria-labelledby="thresholds-title" className="panel">
          <h2 id="thresholds-title">{t.thresholdsTitle}</h2>
          <dl>
            <dt>{t.thresholdQuarantine}</dt>
            <dd data-testid="threshold-quarantine">
              {settings.jev.thresholds.quarantine.toFixed(2)}
            </dd>
            <dt>{t.thresholdAction}</dt>
            <dd data-testid="threshold-action">{settings.jev.thresholds.action.toFixed(2)}</dd>
          </dl>
          <h3>{t.privateDirLabel}</h3>
          <code data-testid="private-dir">{settings.privateDir}</code>
        </section>
      )}
    </div>
  );
}
