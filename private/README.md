# private/

Everything in this folder except this README is gitignored (`.gitignore`: `private/*`,
`!private/README.md`). It holds the operator's data and secrets; nothing here is ever committed,
logged or printed.

Create the skeleton with `npm run setup` (idempotent, never overwrites an existing file).

| Path | Content | Created by |
|---|---|---|
| `settings.json` | settings (shape: repo-root `settings.example.json`) | `npm run setup`; the Settings page pirate toggle writes it (temp file + rename) |
| `.env` | `TYPESAFE_API_KEY=...` | `npm run setup` (empty value); the operator fills it |
| `cache/` | `messages.jsonl`, `decisions.jsonl` (safe to delete; re-fetch rebuilds) | `npm run setup`; refresh appends |
| `state.json` | incremental cursors | refresh |
| `refresh.lock` | cross-process refresh lock (transient) | refresh, `wa:link`, `wa:chats` |
| `google-oauth-client.json` | Desktop OAuth client | operator download |
| `gmail-token.json` | read-only Gmail token | `npm run yarvis -- gmail:auth` |
| `service-account.json` | Sheets writer key | operator download |
| `wa-auth/` | WhatsApp linked-device credentials | `npm run yarvis -- wa:link` |
| `fake/` | isolated private dir used by fake mode (`YARVIS_FAKE=1`) | `npm run dev:fake` |

`YARVIS_PRIVATE_DIR` overrides the location (used by the Playwright smoke for a fresh temp dir).
