# Yarvis — project instructions

## Overview

Single-user local home assistant (Jarvis style, optional pirate-mode strings). v0 pulls messages
READ-ONLY from the operator's WhatsApp (allowlisted chats, on-demand Baileys linked-device session)
and Gmail (inbox since 2026-10-01), screens them with TypeSafe Jev (quarantine), extracts one-line
to-dos with a `claude -p` single-shot, and stores everything in a Google Sheet rendered by a React
front end. Sheets and the gitignored `private/` folder are the ONLY write targets.
Plan: [docs/plans/master_plan.md](docs/plans/master_plan.md).

## Stack

| Layer | Tool |
|---|---|
| Runtime | Node 24, npm workspaces (`shared/`, `server/`, `web/`), TypeScript strict |
| Backend | Express 5 on `127.0.0.1:8787` (`tsx` dev, `tsc` build) |
| Frontend | Vite + React 18 + react-router on `127.0.0.1:5173` (`--strictPort`) |
| WhatsApp | `@whiskeysockets/baileys` 7.x (read side only) + `qrcode-terminal` |
| Gmail / Sheets | `googleapis` — Gmail `gmail.readonly` user OAuth; Sheets service account |
| Classification | `@typesafe-ai/sdk` (`POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`) |
| Extraction | `claude -p --tools "" --model <fast> --output-format json --no-session-persistence --strict-mcp-config --disable-slash-commands`, neutral temp cwd (subscription OAuth, no API key; never the bare-mode flag) |
| Tests / lint | Vitest, Playwright (fake mode), ESLint + Prettier, `tsc --noEmit` |

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
npm test                      # vitest unit + integration
npm run e2e                   # playwright smoke in fake mode
npm run smoke                 # fake-mode end-to-end refresh gate
npm run yarvis -- gmail:auth | wa:link [--reset] | wa:chats | doctor | refresh
```

Gate: run `npm run typecheck`, `npm run lint`, `npm test`, `npm run e2e` (and `npm run smoke` from
Step 8 on) as separate commands, each checked for exit status — no `&&` in PowerShell 5.1.

## Layout

```
shared/src/        types.ts (Message, Todo, ...), sheet.ts (pinned headers), ids.ts
server/src/        index.ts (app factory), main.ts, config/, connectors/{gmail,whatsapp,sheets}.ts,
                   ai/{jev,extract,decide}.ts, pipeline/refresh.ts, routes/, cli.ts, doctor.ts,
                   lock.ts (private/refresh.lock), fakes/
server/fixtures/   fake seeds        server/test/   vitest
web/src/           App.tsx, api.ts, i18n/strings.ts (en + pirate), pages/{Todos,Quarantine,ConnectedApps,Settings}.tsx
web/e2e/           playwright smoke
private/           GITIGNORED (only private/README.md tracked): settings.json, .env, OAuth client,
                   gmail-token.json, service-account.json, wa-auth/, state.json, cache/
docs/plans/        master_plan.md
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
processes via `private/refresh.lock` (the CLI `refresh`/`wa:*` verbs take it too). JSONL caches
in `private/cache` make re-runs idempotent; the Google Sheet (tabs Todos, Quarantine) is the
system of record, upserted by `id`.

**Web**: four routes (Todos, Quarantine, Connected apps, Settings); pirate mode swaps a string
table only.

## Current state

Plan written 2026-10-19, no code yet. Next: `/repo-init`, then `/plan-expedite --plan yarvis/docs/plans/master_plan.md`, then `/build-phase` in an Opus window.

## Environment requirements

- Windows 11, Node >= 20 (24 installed), npm 11, `claude` CLI logged in via subscription OAuth.
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
