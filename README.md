# Yarvis

A single-user, local home assistant in the Jarvis style (with an optional pirate-mode toggle). v0 does
one job: it pulls messages from your personal **WhatsApp** (allowlisted chats) and **Gmail** (inbox
since a configured date), screens every message through TypeSafe's **Jev** decision model for
spam, phishing and malicious content, asks Jev whether each clean message contains an action item,
rewrites each hit into a one-line to-do with a single-shot `claude -p` call, and stores the results in
a **Google Sheet** that a small **React** front end renders as a combined to-do list, a quarantine
folder, a connected-apps page and a settings page.

**Guardrails.** WhatsApp and Gmail are **read only**, pinned in code and tests. Google Sheets (plus
the gitignored `private/` folder) is the only write target. Quarantined messages never reach the
generating model.

> Status: planned, no code yet. See [docs/plans/master_plan.md](docs/plans/master_plan.md).

## Stack

| Layer | Tool | Why |
|---|---|---|
| Runtime | Node 24, npm workspaces (`shared/`, `server/`, `web/`), TypeScript strict | One runtime end to end; Baileys is Node-only |
| Backend | Express 5 on `127.0.0.1:8787` | Smallest well-known HTTP layer; localhost-only is the auth model |
| Frontend | Vite + React 18 + react-router on `127.0.0.1:5173` (`--strictPort`) | Pinned port, no surprises on Windows |
| WhatsApp | `@whiskeysockets/baileys` 7.x (read side only) | Linked-device client, no browser; on-demand session per refresh |
| Gmail / Sheets | `googleapis` | Gmail `gmail.readonly` user OAuth; Sheets via service account |
| Classification | `@typesafe-ai/sdk` (Jev, `jev-latest`) | Cheap typed yes/no decisions; never generates text |
| Extraction | `claude -p --bare --tools ""` (subscription OAuth) | Forced single-shot; no API key in the repo |
| Tests / lint | Vitest, Playwright (fake mode), ESLint + Prettier, `tsc --noEmit` | Fakes let every gate run without credentials |

## Prerequisites

- Node >= 20 (developed on 24) and npm 11
- `claude` CLI logged in via subscription OAuth
- For real connectors (not needed in fake mode): a Google Cloud project with the Gmail and Sheets
  APIs enabled, a Desktop OAuth client, a service-account key, a Google Sheet shared with that
  service account, a TypeSafe API key, and a phone with WhatsApp to scan the link QR

## Setup

1. Clone and install:
   ```powershell
   git clone https://github.com/aberson/yarvis.git; Set-Location yarvis
   npm install
   ```
2. Create the private folder skeleton and settings:
   ```powershell
   npm run setup
   ```
3. Run with every external service faked:
   ```powershell
   npm run dev:fake   # server 127.0.0.1:8787 + web 127.0.0.1:5173
   ```
4. Connect real services, then run for real:
   ```powershell
   npm run yarvis -- gmail:auth
   npm run yarvis -- wa:link
   npm run yarvis -- wa:chats    # copy the chat JIDs you want into private\settings.json
   # put TYPESAFE_API_KEY=... in private\.env and the sheet id in private\settings.json
   npm run yarvis -- doctor
   npm run dev
   ```

Quality gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run e2e`, `npm run smoke`.

## How a refresh works

```
POST /api/refresh
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
├── package.json            # npm workspaces: shared, server, web
├── shared/src/             # types, pinned sheet headers, id helpers
├── server/src/             # Express app, connectors/{gmail,whatsapp,sheets}, ai/{jev,extract,decide},
│                           # pipeline/refresh, routes, cli, fakes
├── web/src/                # React pages: Todos, Quarantine, Connected apps, Settings
├── private/                # GITIGNORED except private/README.md: settings, tokens, caches
└── docs/plans/master_plan.md
```

Public code, private data: everything under `private/` except its README is gitignored, and a test
plus CI assert that.
