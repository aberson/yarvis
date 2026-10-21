# Yarvis — project instructions

## Overview

Single-user local home assistant (Jarvis style, optional pirate-mode strings). v0 pulls messages
READ-ONLY from the operator's WhatsApp (allowlisted chats, on-demand Baileys linked-device session)
and Gmail (inbox since `settings.since`), screens them with TypeSafe Jev (quarantine), extracts one-line
to-dos with a `claude -p` single-shot, and stores everything in a Google Sheet rendered by a React
front end. Sheets and the gitignored `private/` folder are the ONLY write targets.
S1 adds a saved Briefing landing page and per-task preparation packets (draft reply, checklist,
questions) kept in a local SQLite file; nothing is ever sent.
Plan: [docs/plans/master_plan.md](docs/plans/master_plan.md).

## Stack

| Layer | Tool |
|---|---|
| Runtime | Node 24 (engines `>=24.14.0 <25`), npm workspaces (`shared/`, `server/`, `web/`), TypeScript strict |
| Assistant store | built-in `node:sqlite` at `private/assistant.sqlite` (+ sidecars; lock `private/assistant.lock`; schema `user_version` 1; ExperimentalWarning expected) |
| Backend | Express 5 on `127.0.0.1:8787` (`tsx` dev, `tsc` build) |
| Frontend | Vite + React 18 + react-router on `127.0.0.1:5173` (`--strictPort`) |
| WhatsApp | `@whiskeysockets/baileys` 7.0.0-rc14 (exact pin; read side only) + `qrcode-terminal` |
| Gmail / Sheets | `googleapis` — Gmail `gmail.readonly` user OAuth (`html-to-text` for HTML bodies); Sheets service account |
| Classification | `@typesafe-ai/sdk` 0.7.0 exact (`POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`) |
| Extraction / composition | `claude -p --tools "" --model <fast> --output-format json --no-session-persistence --strict-mcp-config --disable-slash-commands`, neutral temp cwd (subscription OAuth, no API key; never the bare-mode flag) |
| Tests / lint | Vitest, Playwright (fake mode), ESLint + Prettier, `tsc --noEmit`, `npm run smoke`, `npm run smoke:assistant`; GitHub Actions CI on Ubuntu (`.github/workflows/ci.yml`) |

Shell: PowerShell (Windows 11). Fake mode `YARVIS_FAKE=1` replaces every external seam.

## Commands

```powershell
npm install
npx playwright install chromium   # once per machine / fresh worktree
npm run setup                 # create private/ skeleton + settings.json
npm run dev:fake              # server --port 8787 + web --port 5173, all connectors faked
npm run dev                   # real connectors (needs private/ configured)
npm run typecheck
npm run lint
npm run build                 # tsc -b (shared/server) + vite build
npm test                      # vitest unit + integration
npm run e2e                   # playwright in fake mode (own servers 8797/5183 + 8798/5184)
npm run smoke                 # fake-mode end-to-end refresh gate
npm run smoke:assistant       # S1 gate: real app/service/SQLite, fake composer + Sheets, close/restart/reopen
npm run yarvis -- gmail:auth | wa:link [--reset] | wa:chats | doctor | refresh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1   # Desktop shortcut
```

Gate: run `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npm run e2e`,
`npm run smoke` and `npm run smoke:assistant` as separate commands, each checked for exit status —
no `&&` in PowerShell 5.1.

## Layout

```
shared/src/        types.ts (Message, Todo, scores, RefreshStatus, status), sheet.ts (pinned headers), ids.ts,
                   since.ts (the one settings.since parser), logos.ts (LOGO_IDS), assistant.ts (S1 wire types)
server/src/        index.ts (app factory), main.ts, http.ts (guard, sendError), access-log.ts, setup.ts,
                   cli.ts (verb dispatcher) + wa-cli.ts + refresh-cli.ts, doctor.ts, lock.ts (refresh.lock),
                   config/ (paths, env, settings), connectors/{gmail,whatsapp,sheets}.ts,
                   ai/{jev,extract,decide,compose}.ts, pipeline/{refresh,job,cache,state,seams,errors,configured,activity}.ts,
                   assistant/{store,service}.ts (S1 SQLite store + one-run service),
                   routes/{health,settings,todos,quarantine,refresh,status,assistant}.ts, util/,
                   fakes/ (5 seams + composer.ts)
server/scripts/    smoke.ts (npm run smoke), assistant-smoke.ts (npm run smoke:assistant)
server/fixtures/   synthetic seeds + manifest.ts (EXPECTED fake-mode totals)      server/test/   vitest
web/src/           App.tsx, api.ts, refresh-poll.ts, i18n/strings.ts (en + pirate), ui/{format,logos},
                   assistant-poll.ts, pages/{Briefing,Preparation,Preparations,Todos,Quarantine,Controls,
                   Connections}.tsx, styles.css (HUD theme tokens)
scripts/           launch.ps1 + install-shortcut.ps1 + yarvis.ico (Desktop shortcut; ASCII-only .ps1)
web/e2e/           playwright (own fake servers: 8797/5183 fixtures; 8798/5184 with YARVIS_FAKE_SHEET_SEED)
private/           GITIGNORED (only private/README.md tracked): settings.json, .env, OAuth client,
                   gmail-token.json, service-account.json, wa-auth/, state.json, cache/, assistant.sqlite
                   (+ -journal/-wal/-shm sidecars), assistant.lock; fake/ in fake mode
.github/workflows/ ci.yml (setup, gates, smoke, smoke:assistant, private-data leak check)
docs/plans/        master_plan.md                     docs/acceptance/   s1.md (M7-M8 operator script)
```

## Architecture

**Connectors** are the only modules that import their SDK (`gmail.ts` ↔ googleapis Gmail,
`whatsapp.ts` ↔ Baileys, `sheets.ts` ↔ googleapis Sheets). Read-only is pinned: Gmail `SCOPES`
is an exact-equality-tested tuple re-checked against the token file's recorded scope; the
WhatsApp wrapper exports nothing send-capable and a grep test fails on `sendMessage`/`readMessages`
anywhere under `server/src`.

**AI seams**: `ai/jev.ts` sends one `systemOne` call per message with four `noul` questions
(phishing, malicious, spam, action); `ai/decide.ts` quarantines at `>= 0.5` and only non-quarantined
messages with action `>= 0.6` reach `ai/extract.ts`, the single `claude -p` subprocess seam
(stdin prompt, untrusted-data wrapping, tolerant parser, tree-kill on timeout).

**Pipeline**: `pipeline/refresh.ts` `runRefresh(deps)` runs whatsapp → gmail → jev → extract →
sheets as one job (`POST /api/refresh`, poll `GET /api/refresh/status`), one at a time across
processes via `private/refresh.lock` (the CLI `refresh`/`wa:*` verbs take it too; stale after 17 min =
15 min job ceiling + 2 min settle grace, D35). Stage errors surfaced to status/CLI/logs use the fixed
content-free vocabulary in `pipeline/errors.ts`. JSONL caches
in `private/cache` make re-runs idempotent; the Google Sheet (tabs Todos, Quarantine) is the
system of record, upserted by `id`.

**Status**: `GET /api/status` reports configured flags (files/env only, no live probes) plus the last
refresh's per-seam success/error; `yarvis doctor` live-probes each configured seam (D24).

**Assistant (S1)**: `assistant/store.ts` owns `private/assistant.sqlite` (runs, briefings, packets
tables; v1 transactional initializer, FKs, 250 ms busy timeout -> 409 `assistant_busy`; corrupt/newer
store fails closed -> 503 `assistant_unavailable`, files untouched, Todos unaffected).
`assistant/service.ts` admits one run at a time under `private/assistant.lock` (existing `acquireLock`,
separate from refresh.lock), request-id idempotency before busy admission, 90 s logical deadline (a
late sheet read is discarded while the lock is held until it settles), startup reconcile of abandoned
`running` rows to interrupted only after taking the lock; `main.ts` runs `init()` before listening
and `close()` waits for owned work then closes the DB. Briefing = fresh Todos + Quarantine reads,
`visibleTodos`, open only, date desc + id tie-break, 25 cap with open/omitted counts. Preparation
re-verifies the selected Todo + Quarantine against the sheet before `ai/compose.ts` (reuses
`runClaude` unchanged, `settings.extract.model`, <= 60 s; strict Composition parser; fake mode wires
`fakes/composer.ts`), stores one packet per Todo (same Todo again = existing packet, no model call),
and saves edits by revision compare-and-swap (stale save -> 409 `revision_conflict` + `currentPacket`).
"Handled" is local packet state only; it never changes the Sheet's Todo. Interrupted runs are never
re-run automatically (explicit Build briefing / Retry). Routes: `POST /api/assistant/briefings`,
`GET /api/assistant/briefings/latest`, `GET /api/assistant/runs/latest`, `GET /api/assistant/runs/:id`,
`POST|GET /api/assistant/preparations`, `GET|PATCH /api/assistant/preparations/:id`.

**Web**: Briefing = landing (`/` redirects there), `/preparations` (saved list, 100 cap + notice) and
`/preparations/:id` (editor: unsaved-change guards, 409 review keep-mine/load-saved, lost-save
re-base); Todos, Quarantine, Controls = connections + settings + logo picker (`/apps` and
`/settings` redirect, D40); pirate mode swaps a string table only. J.A.R.V.I.S. HUD theme tokens live in `web/src/styles.css`; the 10 logos in `web/src/ui/logos.tsx` (ids in `shared/src/logos.ts`).
`settings.since` takes a day or a UTC instant, parsed only by `shared/src/since.ts` (D38). Desktop
launcher: `scripts/launch.ps1` (shortcut via `scripts/install-shortcut.ps1`; keep both ASCII-only).

## Current state

Phase 1.1 complete (2026-10-20) — running live on real Gmail, WhatsApp (4-chat allowlist), Jev and the Google Sheet; M1-M4 done; Y.A.R.V.I.S. HUD theme, 10 logos, Controls page, Desktop shortcut (453 vitest + 10 e2e, last implementation baseline). Open: M5 (#13) two-day observation, M6 (#14) publish check, #18 WhatsApp history backfill.

S1 (master plan Phase 2 / S1): Steps 9–12 (#22–#25) implemented and verified in fake mode only — saved Briefing landing page, one preparation packet per task (draft/checklist/questions), revision-checked edits, handled state, saved list, restart persistence; gated by vitest, Playwright and `npm run smoke:assistant`. Live acceptance M7 (#26, real Desktop → Sheets → Claude substrate) and M8 (#27, restart + handling journey) are PENDING: follow `docs/acceptance/s1.md`; never claim S1 live-accepted on fake evidence. M5 (#13) and M6 (#14) remain separately open. S1 does not send messages or execute project work. S2 is deferred pending the Ambition/Calibration + Forge handback; ownership and proposed contracts live in `docs/plans/s2-integration-agreement.md`, with the other-window prompt in `docs/plans/s2-coordination-prompt.md`. S3 experiment bench is backlog only. See `docs/plans/s1-plan-review.md` and `docs/plans/s1-assistant-proposal.html` for readiness and decision provenance.

## Environment requirements

- Windows 11, Node >= 24.14.0 < 25 (built-in `node:sqlite`), npm 11, `claude` CLI logged in via subscription OAuth.
- Google Cloud project with Gmail API + Sheets API enabled; Desktop OAuth client JSON; service-account key; a Google Sheet shared with the service account (M1).
- `TYPESAFE_API_KEY` in `private/.env` (M2).
- A phone with WhatsApp to scan the link QR (M3). Baileys is unofficial; read-only use accepted by the operator.
- Fake mode needs none of the above.

## Gotchas

- Never print or `cat` anything under `private/` (workspace security rule); `doctor` reports status only.
- `claude -p` inherits the operator's power-user config unless isolated with a neutral temp cwd, `--tools ""`, a pinned `--model`, `--no-session-persistence`, `--strict-mcp-config` and `--disable-slash-commands`. Never use the bare-mode flag: it reads only `ANTHROPIC_API_KEY` and skips subscription OAuth, so every extraction would fail auth. `--output-format json` wraps the answer in an envelope; parse its `.result`.
- npm runs scripts through cmd.exe on Windows: set env vars with `cross-env`, never inline `VAR=1`.
- Vite on Windows: keep `--host 127.0.0.1 --strictPort`.
- Fresh worktrees need `npm install` before the first gate.
- Never delete `private/assistant.sqlite` to "fix" an unavailable assistant (corrupt/newer DB = 503, Todos still work): stop the server, copy it and any `-journal`/`-wal`/`-shm` sidecar aside, restore a stopped-server backup (README "Assistant startup, recovery and backup").
- Playwright owns 8797/5183 and 8798/5184 (run reviewer servers on other ports or sequentially); `smoke` and `smoke:assistant` use ephemeral ports and temp private dirs. `YARVIS_FAKE_SHEET_SEED` (absolute path to a `{Todos, Quarantine}` JSON) is honoured in fake mode only.
- WhatsApp sends a linked device its history ONCE, on the first connection after `wa:link`; whichever command connects first consumes it (`wa:chats` keeps only names). To backfill: re-link, clear the `whatsapp` cursor in `private/state.json`, refresh before `wa:chats` (#18).
- The operator's `npm run dev` hot-reloads the working tree (tsx watch + Vite HMR): branch edits go live in their open app.
- Windows npm installs the Claude CLI as `claude.cmd`; `ai/extract.ts` resolves `.exe`/`.cmd`/`.bat` and spawns a `.cmd` via `cmd.exe /d /s /c` with per-argument quoting — keep message content out of argv (prompt goes on stdin).
