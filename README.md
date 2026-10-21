# Yarvis

A single-user, local home assistant in the Jarvis style (with an optional pirate-mode toggle). v0 does
one job: it pulls messages from your personal **WhatsApp** (allowlisted chats) and **Gmail** (inbox
since a configured date), screens every message through TypeSafe's **Jev** decision model for
spam, phishing and malicious content, asks Jev whether each clean message contains an action item,
rewrites each hit into a one-line to-do with a single-shot `claude -p` call, and stores the results in
a **Google Sheet** that a small **React** front end renders as a combined to-do list, a quarantine
folder and a Controls page (connections, settings and the logo picker).

**Guardrails.** WhatsApp and Gmail are **read only**, pinned in code and tests. Google Sheets (plus
the gitignored `private/` folder) is the only write target. Quarantined messages never reach the
generating model.

> **Phase 2 / S1 automated build complete** — issues #22–#25 closed. Saved Briefing landing page, one
> source-grounded reply preparation per task, revision-checked editing with a local handled state, and
> restart persistence, verified in fake mode. 586 tests passing (plus 32 Playwright specs and both smokes),
> 0 type errors, 0 lint violations. Live acceptance M7–M8 (#26, #27) and Phase 1 operator steps M5–M6
> remain open in [docs/plans/master_plan.md](docs/plans/master_plan.md).

## Personal briefing and preparation (S1: built; live acceptance pending)

S1 is “brief me, then help me handle one request”: a saved **Briefing** landing page, then one
**preparation** per selected task (an editable reply draft, checklist and open questions) that you
can save, mark handled and reopen after a restart. Yarvis never sends anything; replying stays
manual. Steps 9–12 are implemented and verified in **fake mode** (Vitest, Playwright and
`npm run smoke:assistant`). The live acceptance steps M7 (real Desktop → Sheets → Claude journey)
and M8 (restart and handling) are **pending**; their operator script is
[docs/acceptance/s1.md](docs/acceptance/s1.md). See the
[proposal](docs/plans/s1-assistant-proposal.html), [review](docs/plans/s1-plan-review.md), and
[master plan](docs/plans/master_plan.md) (Phase 2 / S1).
S2 project delegation is deferred until Ambition/Calibration and Forge finish their current work;
the [coordination prompt](docs/plans/s2-coordination-prompt.md) and
[integration agreement](docs/plans/s2-integration-agreement.md) define the intended ownership.
The optional experiment bench stays in the backlog.

## Stack

| Layer | Tool | Why |
|---|---|---|
| Runtime | Node 24 (>= 24.14.0, < 25), npm workspaces (`shared/`, `server/`, `web/`), TypeScript strict | One runtime end to end; Baileys is Node-only |
| Backend | Express 5 on `127.0.0.1:8787` | Smallest well-known HTTP layer; localhost-only is the auth model |
| Frontend | Vite + React 18 + react-router on `127.0.0.1:5173` (`--strictPort`) | Pinned port, no surprises on Windows |
| WhatsApp | `@whiskeysockets/baileys` 7.x (read side only) | Linked-device client, no browser; on-demand session per refresh |
| Gmail / Sheets | `googleapis` | Gmail `gmail.readonly` user OAuth; Sheets via service account |
| Classification | `@typesafe-ai/sdk` (Jev, `jev-latest`) | Cheap typed yes/no decisions; never generates text |
| Extraction | `claude -p --tools ""` single-shot (subscription OAuth, neutral temp cwd, pinned model) | Forced single-shot; no API key in the repo |
| Assistant store | Built-in `node:sqlite` (`private/assistant.sqlite`) | Transactional runs, briefing snapshots and preparation packets; no native package, no external DB |
| Tests / lint | Vitest, Playwright (fake mode), ESLint + Prettier, `tsc --noEmit`, `npm run smoke`, `npm run smoke:assistant` | Fakes let every gate run without credentials |

## Prerequisites

- Node 24.14.0 or later within major 24 (`engines: >=24.14.0 <25`; the built-in `node:sqlite`
  module the assistant uses prints an ExperimentalWarning, which is expected) + npm 11, git
- The Claude Code CLI (`claude`) on PATH and logged in with your subscription (its own credential
  store; nothing goes in `private/`)
- For real connectors (not needed in fake mode): a Google Cloud project with the Gmail and Sheets
  APIs enabled, a Desktop OAuth client, a service-account key, a Google Sheet shared with that
  service account, a TypeSafe API key, and a phone with WhatsApp to scan the link QR

Windows PowerShell is the primary shell; CI runs on Ubuntu.

## Quickstart (fake mode, no accounts needed)

```powershell
git clone https://github.com/aberson/yarvis.git; Set-Location yarvis
npm install
npx playwright install chromium
npm run setup            # creates private/ skeleton + settings.json from settings.example.json
npm run dev:fake         # server 127.0.0.1:8787 + web 127.0.0.1:5173 with fake connectors
```

Open http://127.0.0.1:5173: it lands on the **Briefing** page (`/` redirects to `/briefing`). On
the Todos page press **Refresh**: every external seam (WhatsApp, Gmail, Jev,
Claude, Sheets) is a seeded fake. `npm run setup` is idempotent and never overwrites an existing
file: it creates `private/cache/`, `private/settings.json` (copied from `settings.example.json`)
and `private/.env` with an empty `TYPESAFE_API_KEY=` line. Fake mode keeps its data in
`private/fake/` (or `YARVIS_PRIVATE_DIR` when set).

## Connect real services

Each is a manual step in the plan (M1-M3):

```powershell
npm run yarvis -- gmail:auth   # Gmail read-only OAuth consent; writes private/gmail-token.json
npm run yarvis -- wa:link      # scan the QR to link WhatsApp as a device
npm run yarvis -- wa:chats     # list chat JIDs; copy the ones you want into private/settings.json
```

Then put `TYPESAFE_API_KEY` in `private/.env`, put the sheet id in `private/settings.json` and share
the sheet with the service-account email, and check every seam:

```powershell
npm run yarvis -- doctor       # live probe per seam: ok | not configured | error
npm run dev                    # the day-to-day run mode (watch)
```

`npm run build` / `npm start` exist for CI and a non-watch run.

## Desktop shortcut (Windows)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
```

Creates a **Yarvis** shortcut on the Desktop. Double-clicking it opens the app in the browser on the Briefing page; if
Yarvis is not running it first starts `npm run dev` in a minimized "Yarvis" window (close that
window to stop it).

## Briefing

The landing page (`/briefing`, also what the Desktop shortcut opens) shows a saved snapshot of your
open, screened to-dos. **Build briefing** reads the Todos and Quarantine tabs of the sheet now — it
does not fetch mail or WhatsApp; use **Refresh** on the Todos page for that — and stores the result
in `private/assistant.sqlite`. Each snapshot shows its age, the full open count, up to 25 newest
items (the rest are counted with a link to Todos), per-source coverage (freshness is always
"unknown": the sheet's read time is not a connector sync time) and marks items "New to this
briefing" compared with the previous snapshot (the first one is a baseline). Pending extractions are
listed but not ready to prepare. If a sheet read fails, the run is shown as failed and the previous
snapshot stays, labelled historical. Only the newest 50 snapshots (and 200 finished briefing runs) are
kept, so message excerpts do not pile up in the database. One assistant run at a time (`private/assistant.lock`); a run
in flight when the server stopped shows as interrupted after restart and is never re-run on its own.

## Preparations

On a briefing card, **Prepare reply** re-checks that task against the sheet (it must still be open,
extracted and not quarantined; otherwise Refresh and build a new briefing), then asks the same
isolated, tool-free `claude -p` runner the extractor uses (your `extract.model`, at most 60 s) for a
draft reply, a 1–12 item checklist and any open questions. Source text is treated as untrusted data;
unknown facts become questions. The result is saved before it is shown, at `/preparations/<id>`.
Preparing the same task again opens the saved one (no new model call).

- **Edit and save.** Edit the draft, the checklist texts and boxes and the questions, then **Save**.
  Unsaved edits are flagged, and leaving or reloading asks first. Every save is revision-checked:
  if another tab saved first you get the saved version for review and choose “keep my edits” or
  “load saved version”; nothing is overwritten silently and a failed save keeps your text.
- **Handled.** **Save and mark handled** (and **Save and reopen**) is a local status of the preparation only.
  It never sends anything and never completes the Todo: completing the task is the separate action
  on the Todos page (linked from the preparation).
- **Saved preparations** (`/preparations`) lists the 100 most recently updated, with a total and a
  notice when older ones are not listed. Saved work survives a server restart.
- A preparation that failed or was interrupted shows on its card with **Retry** (a new request);
  nothing is regenerated over your edits.

Assistant routes (all behind the loopback Host check; POST/PATCH need `X-Yarvis: 1`):

| Method and path | Purpose |
|---|---|
| `POST /api/assistant/briefings` | start a briefing run (`{requestId}`) |
| `GET /api/assistant/briefings/latest` | the latest saved snapshot |
| `GET /api/assistant/runs/latest`, `GET /api/assistant/runs/:id` | run state (reconnect after a reload) |
| `POST /api/assistant/preparations` | prepare one task (`{requestId, briefingId, todoId}`) |
| `GET /api/assistant/preparations`, `GET /api/assistant/preparations/:id` | saved list / one packet |
| `PATCH /api/assistant/preparations/:id` | revision-checked save (`{expectedRevision, draft, checklist, questions, state}`) |

### Assistant startup, recovery and backup

The assistant's state is `private/assistant.sqlite` (plus any SQLite sidecar beside it while in
use: `assistant.sqlite-journal`, or `-wal`/`-shm`), guarded by `private/assistant.lock`. The Google
Sheet still owns the Todos; the database owns only briefings, runs and preparations.

- **Startup.** The server opens the store and, holding the assistant lock, marks runs a stopped
  server left `running` as **interrupted**. They are never re-run automatically: press
  **Build briefing** or the card's **Retry** when ready.
- **Corrupt or newer database.** The assistant answers “assistant storage is unavailable” and the
  Briefing and preparation pages say so; Todos, Quarantine, Refresh and Controls keep working. The
  file is left exactly as found. **Never delete the database to “fix” it**: stop the server, copy
  the file and its sidecars somewhere safe, then restore a known-good backup (below), or move the
  bad files aside deliberately, knowing the saved preparations go with them.
- **Backup** (server stopped: close the minimized “Yarvis” window, or Ctrl+C `npm run dev`). Run
  from the repo folder; it copies `assistant.sqlite` and any sidecar together, outside the repo
  (backups contain message excerpts, so never put them in a tracked folder):

  ```powershell
  $dest = Join-Path $env:USERPROFILE ("yarvis-backups\assistant-" + (Get-Date -Format yyyyMMdd-HHmmss))
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item private\assistant.sqlite* $dest
  ```

- **Restore** (server stopped): move the current `private\assistant.sqlite*` files aside (do not
  delete them), copy the backup's `assistant.sqlite*` files into `private\`, then start Yarvis.

## Recovery

| Symptom | Fix |
|---|---|
| WhatsApp `loggedOut` (`relink required` on the Controls page) | `npm run yarvis -- wa:link --reset` |
| Gmail token expired (Testing-mode consent lasts about 7 days) | `npm run yarvis -- gmail:auth` |
| Suspect local cache | delete `private/cache` (the Google Sheet is the system of record and survives; the next refresh re-reads and re-screens) |
| Briefing says assistant storage is unavailable (corrupt or newer `assistant.sqlite`) | Todos keep working. Never delete the database: stop the server, copy `private/assistant.sqlite*` aside and restore a backup (see [Assistant startup, recovery and backup](#assistant-startup-recovery-and-backup)); Yarvis never repairs or recreates it on its own |
| A briefing or preparation shows as interrupted | the server stopped mid-run; nothing re-runs by itself: press **Build briefing** or **Retry** |
| Back up / restore briefings and preparations | with the server stopped, copy `private/assistant.sqlite` plus any `-journal`/`-wal`/`-shm` sidecar beside it; restore the same way |
| Stuck refresh job | it ends `error` at the 15 min ceiling, or restart the server (a dead process's `private/refresh.lock` is reclaimed) |

## Tests and gates

```powershell
npm run typecheck
npm run lint                   # eslint + prettier --check
npm run build
npm test                       # vitest unit + integration
npm run e2e                    # playwright, fake mode (own servers on 8797/5183 and 8798/5184)
npm run smoke                  # fake-mode end-to-end refresh gate
npm run smoke:assistant        # S1 journey: briefing -> prepare -> edit -> restart -> reopen
```

Run each as its own command and check its exit status (no `&&` in Windows PowerShell 5.1).
`npm run smoke` starts the real server entry in fake mode on a free port with a fresh temp private
dir, POSTs `/api/refresh`, polls `/api/refresh/status` until `done` (30 s budget), checks the
Todos / Quarantine counts against `server/fixtures/manifest.ts`, then kills the server and removes
the temp dir; it exits non-zero on any failure.

`npm run e2e` starts two isolated fake servers with their own temp private dirs: 8797/5183 (the
standard fixtures) and 8798/5184, which loads a synthetic sheet through the fake-mode-only
`YARVIS_FAKE_SHEET_SEED` (an absolute path to a `{Todos, Quarantine}` JSON file; ignored outside
fake mode). Do not run reviewer servers on those ports at the same time.

`npm run smoke:assistant` (60 s budget; typically a few seconds) runs the real app, routes,
assistant service and SQLite store in process on ephemeral ports with a fresh temp private dir.
Only the external boundaries are deterministic fakes: the in-memory Sheets store and a synthetic
composer in place of the `claude` CLI. It builds a briefing, prepares a planted task, saves an edit
(draft + checkbox) and marks it handled, closes the server, starts it again on the same private dir
and checks that the packet, saved list and briefing read back identical (and that preparing again
makes no model call). It plants synthetic secret-like text in the task's message and proves it
never appears in the captured server output or in error responses (only in the saved packet's
source excerpt, where it belongs), and separately runs a no-mocks SQLite initialize / write /
reopen / read check. It does **not** prove the real Claude CLI or Google Sheets coupling: that is
live acceptance M7–M8 ([docs/acceptance/s1.md](docs/acceptance/s1.md)).

CI (`.github/workflows/ci.yml`, Ubuntu, Node 24) first runs the private-folder leak check on the
committed tree: under `private/` (any letter case) only `private/README.md` is tracked, no tracked
file is one `.gitignore` excludes, and the secret scans find nothing: a TypeSafe key with a real
value (any file), the M6 secret field names (outside code, fixtures and docs), and private-key /
Google / Anthropic credential shapes (any file). It prints file names only. Then `npm ci`,
`npx playwright install --with-deps chromium`, `npm run setup` and every gate above.

## How a refresh works

```
POST /api/refresh            (localhost Host + header X-Yarvis: 1)
  whatsapp : on-demand Baileys session -> drain allowlisted chats -> cache
  gmail    : OAuth (readonly) -> messages since the configured date -> cache
  jev      : one call per new message: phishing, malicious, spam, has_action_item
             quarantined = any security score >= 0.5
             actionable  = not quarantined and has_action_item >= 0.6
  extract  : claude -p -> 1..3 one-line actions (failure -> row kept as "pending")
  sheets   : upsert Quarantine and Todos rows by id
GET /api/refresh/status -> per-stage progress
```

## Key design decisions

- **On-demand WhatsApp, not a daemon.** Each refresh opens a linked-device session, drains, and
  closes. Never sends, no presence, no read receipts. Baileys is unofficial; read-only use is an
  accepted risk.
- **Read only, enforced three ways.** The Gmail scope tuple is exact-equality tested and re-checked
  against the stored token; the WhatsApp wrapper exports nothing send-capable and a grep test fails
  on any send/read-receipt call; only the Sheets module holds a write scope.
- **Jev before anything, fail closed.** If Jev is down, the refresh stops at the `jev` stage and no
  unscreened message is extracted.
- **The sheet is the system of record.** Local JSONL caches under `private/cache` are cursors;
  deleting them costs API calls, not data. All sheet writes are upserts by id.
- **Fake mode is first class.** `YARVIS_FAKE=1` replaces every external seam with seeded fakes for
  tests, CI and a first click-through.
- **Pirate mode is strings only.** A second string table and one boolean.

## Project structure

```
yarvis/
├── package.json            # npm workspaces: shared, server, web; root scripts
├── settings.example.json   # tracked template copied by `npm run setup`
├── .github/workflows/ci.yml
├── shared/src/             # types, pinned sheet headers, id helpers
├── server/src/             # Express app, connectors/{gmail,whatsapp,sheets}, ai/{jev,extract,decide,compose},
│                           # pipeline/refresh, assistant/{store,service}, routes, cli, doctor, fakes (incl. composer)
├── server/scripts/         # smoke.ts (`npm run smoke`), assistant-smoke.ts (`npm run smoke:assistant`)
├── scripts/                # Desktop launcher: launch.ps1, install-shortcut.ps1, yarvis.ico
├── web/src/                # React pages: Briefing (landing), Preparation(s), Todos, Quarantine, Controls
├── private/                # GITIGNORED except private/README.md: settings, tokens, caches, assistant.sqlite
├── docs/acceptance/s1.md   # S1 live acceptance script (M7, M8)
└── docs/plans/master_plan.md
```

Public code, private data: everything under `private/` except its README is gitignored; a test and
CI assert that the tracked set under `private/` is exactly `private/README.md`.
