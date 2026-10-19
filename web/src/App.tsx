// App shell: nav (Todos, Quarantine, Connected apps, Settings — D12) + routes (plan §5).
// Connected apps is built by a later step (Step 7); until then it says so plainly.
import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import type { Settings, SettingsResponse } from "@yarvis/shared";
import { api } from "./api.js";
import { PirateContext, usePirate, type StringKey } from "./i18n/strings.js";
import { QuarantinePage } from "./pages/Quarantine.js";
import { SettingsPage } from "./pages/Settings.js";
import { TodosPage } from "./pages/Todos.js";

const NAV: ReadonlyArray<{ to: string; label: StringKey; testId: string }> = [
  { to: "/todos", label: "navTodos", testId: "nav-todos" },
  { to: "/quarantine", label: "navQuarantine", testId: "nav-quarantine" },
  { to: "/apps", label: "navApps", testId: "nav-apps" },
  { to: "/settings", label: "navSettings", testId: "nav-settings" },
];

function NotBuiltYet({ title }: { title: StringKey }) {
  const t = usePirate();
  return (
    <section>
      <h1>{t[title]}</h1>
      <p className="muted">{t.notBuiltYet}</p>
    </section>
  );
}

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
        <span className="brand">{t.appName}</span>
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
          <Route path="/" element={<Navigate to="/todos" replace />} />
          <Route path="/todos" element={<TodosPage settings={settings} />} />
          <Route path="/quarantine" element={<QuarantinePage />} />
          <Route path="/apps" element={<NotBuiltYet title="navApps" />} />
          <Route
            path="/settings"
            element={<SettingsPage settings={settings} onChange={onSettingsChange} />}
          />
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
