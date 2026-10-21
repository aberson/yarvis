# S1 planning review and fresh-context check

Date: 2026-10-20. Scope: canonical master plan Phase 2 / S1, new decisions P11–P15/D42–D48, and S2 integration agreement. Baseline HEAD inspected: `553d734`. This record reports static planning checks, not code acceptance. No live connector calls, producer launches, full application tests, issue writes, or implementation changes were made.

## Plan-review

[!] Detected non-blank Issue fields — repo-sync appears to have already run. Findings applied to plan.md will require corresponding `gh issue edit` updates (N+1 rework). See `feedback_plan_review_before_repo_sync.md`.

Reviewing as: feature plan. Sections 17–21 apply.

Scope clarification: populated issues belong to existing Phase 1; S1 Steps 9–12 and M7–M8 have blank issue fields. Prior step bodies were not substantively edited. Future issue synchronization must target the selected S1 slice, not re-dispatch the old master or S2 requirements.

An independent reviewer first inspected the actual Calibration and Forge producers and recommended reusing the mobile-oriented controls/bridge, with Yarvis as the front door. The reviewer then ran the plan-review checklist against the S1 draft and performed one bounded recheck after corrections.

### Findings resolved

| Finding | Producer evidence | Resolution |
|---|---|---|
| Composer confused process result with parsed envelope | `server/src/ai/extract.ts`: ClaudeRunResult and runClaude | Explicit exit/timeout/error validation, envelope parsing, is_error rejection, then strict Composition parsing |
| Deadline confused logical failure with settled I/O | `server/src/connectors/sheets.ts`: readRows has no caller signal; `util/retry.ts` retry bounds | 90-second visible deadline; retain lock until reads settle; no late model start/result write |
| Source-change refusal lacked snapshot identity | Proposed prepare route and existing Todo source fields | Add briefingId; compare saved SourceRef with freshly verified source before composition |
| Capped snapshots could imply old mail was new | Proposed 25-item cap and isNew rule | Explicit “new to this briefing” label, never new-mail claim |
| Existing-packet fast path could bypass request identity | Proposed unique request/run contract | Atomic request hash/result run mapping plus repeated lookup inside admission lock |
| Recovery ownership was postponed to editing step | Step 11 draft vs durable runs in Step 9 | Lifecycle/recovery in Step 9, composition abort in Step 10; Step 11 owns editing/reopen |
| Reload could lose the only run handle | Proposed poll-only API | GET latest run, reconnect on mount, correlate request identity, no implicit POST replay |
| File/wire details differed between sections | App/api paths, list response, main lifecycle assignment | Exact file paths and list response corrected; main/docs/tests assigned to Step 9 |
| Long synchronous SQLite busy wait | Selected built-in synchronous driver | 250ms contention bound with retryable busy result |
| Submission can precede attempt creation | Proposed S2 result | attemptId nullable until producer attempt exists |

Reviewer recheck: all previously reported substantive findings resolved; ready for redline and plan-wrap. One punctuation typo subsequently fixed. No product decision was substituted for an operator choice.

### Checklist coverage

| Checks | Result |
|---|---|
| 1–5 persistence, integrations, credentials, concurrency, errors | Store ownership, atomic saves, admission, explicit failure and existing credential boundaries specified |
| 6–10 toolchain, decisions, setup, deduplication, seams | All six command classes supplied; fixed S1 defaults; typed routes and idempotency defined |
| 11–14 scope, security, tests, operations | One on-demand journey; no new execution tools; source validation and fake-mode coverage; desktop start/stop retained |
| 15 autonomous observation | No autonomous scheduling in S1; on-demand polling does not create a daemon requirement |
| 15.5 pipeline smoke | Step 12 real local components/SQLite smoke; external fakes explicitly distinguished from M7 live dependencies |
| 16–21 fresh context, producer validation, impact, conflicts, scope | Additive contracts; actual code/call sites read; isolated worktrees required because main dev server hot-reloads |
| 22–25 step shape and flags | Four code slices, two separate operator checks; no conditional placeholders; full-review steps have start command and URL |
| 26 live substrate | M7 proves real CLI/Sheets; M8 proves useful restart journey before S1 acceptance |
| 27 review stakes | Tool/untrusted-content step uses deep review; other full-stack steps use full review |

### Remaining severity tiers

- **Blockers:** None.
- **Significant gaps:** None outstanding in S1.
- **Missing items:** None outstanding in S1.
- **Nice-to-haves:** None required for dispatch. S2 transport and producer adaptation remain future scoped work, not S1 readiness claims.

Corrections were applied during plan authoring and independently rechecked; no skill autofix marker claims are made. Zero items require additional operator input for the selected S1 plan. Issue binding is still required before build.

## Plan-redline

Publication 1: [S1 operator proposal](s1-assistant-proposal.html). P11–P15 record explicit operator choices; D42–D48 record agent defaults and corresponding rationale/tweak axes. The original P1–P10/D1–D41 IDs are preserved. Canonical source remains [master_plan.md](master_plan.md); the proposal is a view, not another queue.

## Plan-wrap

Completion gate: 12 of 20 build units (steps/phases) complete; 8 still unbuilt -- running full check, focused on unbuilt units.

The eight unbuilt units are existing M5/M6 plus S1 Steps 9–12/M7–M8. S2/S3 are explicitly deferred direction/backlog and contain no executable step queue. Existing v0 contracts are preserved; Phase 2 identifies its overrides. Check performed after redline publication.

§1 Schemas and data structures — pass

§2 Identifiers — pass

§3 Acronyms and tool names — pass

§4 Stack decisions with rationale — pass

§5 Unresolved decisions — pass

§6 API contracts — pass

§7 Development process — pass

§8 Quickstart / how to run — pass

§9 Referenced external files — pass

§10 Scope and constraints — pass

§11 Operator/code step-shape integrity (Blocker if violated) — pass

§12 Conditional steps must declare a Condition: predicate (Blocker) — N/A: no new conditional steps

§13 Substrate-smoke step present when the plan touches deployment seams (Significant Gap) — pass

Evidence: new entities and API shapes are inline in S1.5; UUID generation and request hashing are specified; S1.6 defines defaults; S1.7 splits implementation and operator acceptance; S1.9 defines commands and the live/fake boundary. Existing producer paths were checked by reads/rg. New implementation paths are explicitly outputs. Local documentation hyperlinks resolve; old historical web references were not revalidated as part of this feature scope. The private runtime store is never read for this report.

**Blocker:** None.

**Gap:** None.

**Minor:** None remaining.

Next: scoped repo-sync for S1 after proposal feedback, then build-phase for Steps 9–12. M7–M8 remain real acceptance work; neither this report nor a future automated pass marks them complete.

READY
