// App shell: logo + wordmark, nav (Briefing, Todos, Quarantine, Controls — D12, D40, S1) + routes
// (plan §5). `/` (the Desktop shortcut's landing URL) redirects to /briefing (S1 Step 9); the old
// /apps and /settings routes redirect to /controls so bookmarks keep working.
import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import type { Settings, SettingsResponse } from "@yarvis/shared";
import { api } from "./api.js";
import { PirateContext, usePirate, type StringKey } from "./i18n/strings.js";
import { BriefingPage } from "./pages/Briefing.js";
import { ControlsPage } from "./pages/Controls.js";
import { QuarantinePage } from "./pages/Quarantine.js";
import { TodosPage } from "./pages/Todos.js";
import { Logo } from "./ui/logos.js";

const NAV: ReadonlyArray<{ to: string; label: StringKey; testId: string }> = [
  { to: "/briefing", label: "navBriefing", testId: "nav-briefing" },
  { to: "/todos", label: "navTodos", testId: "nav-todos" },
  { to: "/quarantine", label: "navQuarantine", testId: "nav-quarantine" },
  { to: "/controls", label: "navControls", testId: "nav-controls" },
];

function Shell({
  settings,
  fake,
  loadError,
  onSettingsChange,
}: {
  settings: SettingsResponse | null;
  fake: boolean;
  loadError: string | null;
  onSettingsChange: (next: Settings) => void;
}) {
  const t = usePirate();
  return (
    <div className="app">
      <header className="header">
        <span className="brand" data-testid="brand">
          <Logo id={settings?.logo} size={40} />
          <span className="wordmark">{t.brand}</span>
        </span>
        {fake && <span className="badge">{t.fakeModeBadge}</span>}
        <nav aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} data-testid={item.testId}>
              {t[item.label]}
            </NavLink>
          ))}
        </nav>
      </header>
      <main>
        {loadError && (
          <p role="alert" className="error">
            {t.loadError}: {loadError}
          </p>
        )}
        <Routes>
          <Route path="/" element={<Navigate to="/briefing" replace />} />
          <Route path="/briefing" element={<BriefingPage />} />
          <Route path="/todos" element={<TodosPage settings={settings} />} />
          <Route path="/quarantine" element={<QuarantinePage />} />
          <Route
            path="/controls"
            element={<ControlsPage settings={settings} onChange={onSettingsChange} />}
          />
          <Route path="/apps" element={<Navigate to="/controls" replace />} />
          <Route path="/settings" element={<Navigate to="/controls" replace />} />
          <Route path="*" element={<Navigate to="/todos" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [fake, setFake] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getSettings(), api.health()])
      .then(([s, h]) => {
        if (cancelled) return;
        setSettings(s);
        setFake(h.fake);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSettingsChange = useCallback((next: Settings) => {
    setSettings((prev) => (prev ? { ...next, privateDir: prev.privateDir } : prev));
  }, []);

  return (
    <PirateContext.Provider value={settings?.pirate ?? false}>
      <Shell
        settings={settings}
        fake={fake}
        loadError={loadError}
        onSettingsChange={onSettingsChange}
      />
    </PirateContext.Provider>
  );
}
