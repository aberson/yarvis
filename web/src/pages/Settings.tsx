// Settings page (plan §5): pirate toggle (PATCH /api/settings {pirate}), read-only thresholds, and
// the resolved private dir path.
import { useState } from "react";
import type { Settings, SettingsResponse } from "@yarvis/shared";
import { api } from "../api.js";
import { usePirate } from "../i18n/strings.js";

export function SettingsPage({
  settings,
  onChange,
}: {
  settings: SettingsResponse | null;
  onChange: (next: Settings) => void;
}) {
  const t = usePirate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!settings) {
    return (
      <section>
        <h1>{t.settingsTitle}</h1>
        <p className="muted">{t.loading}</p>
      </section>
    );
  }

  const toggle = async () => {
    setSaving(true);
    setError(null);
    try {
      onChange(await api.patchSettings({ pirate: !settings.pirate }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h1>{t.settingsTitle}</h1>
      <div className="row">
        <span id="pirate-label">{t.pirateLabel}</span>
        <button
          type="button"
          data-testid="pirate-toggle"
          aria-labelledby="pirate-label"
          aria-pressed={settings.pirate}
          disabled={saving}
          onClick={() => void toggle()}
        >
          {saving ? t.saving : settings.pirate ? t.pirateOn : t.pirateOff}
        </button>
        <span className="muted">{t.pirateHint}</span>
      </div>
      {error && (
        <p role="alert" className="error">
          {t.saveError}: {error}
        </p>
      )}
      <h2>{t.thresholdsTitle}</h2>
      <dl>
        <dt>{t.thresholdQuarantine}</dt>
        <dd data-testid="threshold-quarantine">{settings.jev.thresholds.quarantine.toFixed(2)}</dd>
        <dt>{t.thresholdAction}</dt>
        <dd data-testid="threshold-action">{settings.jev.thresholds.action.toFixed(2)}</dd>
      </dl>
      <h2>{t.privateDirLabel}</h2>
      <code data-testid="private-dir">{settings.privateDir}</code>
    </section>
  );
}
