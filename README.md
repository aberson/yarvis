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

> **Phase 1.1 complete** — issues #9–#12 closed. Running live on real Gmail, WhatsApp, Jev and Google
> Sheets, with the Y.A.R.V.I.S. HUD theme, 10 selectable logos, the merged Controls page and a Desktop
> shortcut. 453 tests passing, 0 type errors, 0 lint violations. Remaining operator steps M5–M6 are in
> [docs/plans/master_plan.md](docs/plans/master_plan.md).

## Stack

| Layer | Tool | Why |
|---|---|---|
| Runtime | Node 24, npm workspaces (`shared/`, `server/`, `web/`), TypeScript strict | One runtime end to end; Baileys is Node-only |
| Backend | Express 5 on `127.0.0.1:8787` | Smallest well-known HTTP layer; localhost-only is the auth model |
| Frontend | Vite + React 18 + react-router on `127.0.0.1:5173` (`--strictPort`) | Pinned port, no surprises on Windows |
| WhatsApp | `@whiskeysockets/baileys` 7.x (read side only) | Linked-device client, no browser; on-demand session per refresh |
| Gmail / Sheets | `googleapis` | Gmail `gmail.readonly` user OAuth; Sheets via service account |
| Classification | `@typesafe-ai/sdk` (Jev, `jev-latest`) | Cheap typed yes/no decisions; never generates text |
| Extraction | `claude -p --tools ""` single-shot (subscription OAuth, neutral temp cwd, pinned model) | Forced single-shot; no API key in the repo |
| Tests / lint | Vitest, Playwright (fake mode), ESLint + Prettier, `tsc --noEmit` | Fakes let every gate run without credentials |

## Prerequisites

- Node 24 + npm 11, git
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

Open http://127.0.0.1:5173 and press **Refresh**: every external seam (WhatsApp, Gmail, Jev,
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

Creates a **Yarvis** shortcut on the Desktop. Double-clicking it opens the app in the browser; if
Yarvis is not running it first starts `npm run dev` in a minimized "Yarvis" window (close that
window to stop it).

## Recovery

| Symptom | Fix |
|---|---|
| WhatsApp `loggedOut` (`relink required` on the Controls page) | `npm run yarvis -- wa:link --reset` |
| Gmail token expired (Testing-mode consent lasts about 7 days) | `npm run yarvis -- gmail:auth` |
| Suspect local cache | delete `private/cache` (the Google Sheet is the system of record and survives; the next refresh re-reads and re-screens) |
| Stuck refresh job | it ends `error` at the 15 min ceiling, or restart the server (a dead process's `private/refresh.lock` is reclaimed) |

## Tests and gates

```powershell
npm run typecheck
npm run lint                   # eslint + prettier --check
npm run build
npm test                       # vitest unit + integration
npm run e2e                    # playwright, fake mode (own server on 8797 + web on 5183)
npm run smoke                  # fake-mode end-to-end refresh gate
```

Run each as its own command and check its exit status (no `&&` in Windows PowerShell 5.1).
`npm run smoke` starts the real server entry in fake mode on a free port with a fresh temp private
dir, POSTs `/api/refresh`, polls `/api/refresh/status` until `done` (30 s budget), checks the
Todos / Quarantine counts against `server/fixtures/manifest.ts`, then kills the server and removes
the temp dir; it exits non-zero on any failure.

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
├── server/src/             # Express app, connectors/{gmail,whatsapp,sheets}, ai/{jev,extract,decide},
│                           # pipeline/refresh, routes, cli, doctor, fakes
├── server/scripts/smoke.ts # `npm run smoke`
├── scripts/                # Desktop launcher: launch.ps1, install-shortcut.ps1, yarvis.ico
├── web/src/                # React pages: Todos, Quarantine, Controls (logo picker + connections)
├── private/                # GITIGNORED except private/README.md: settings, tokens, caches
└── docs/plans/master_plan.md
```

Public code, private data: everything under `private/` except its README is gitignored; a test and
CI assert that the tracked set under `private/` is exactly `private/README.md`.
