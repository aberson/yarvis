# S2 integration agreement — draft 1

Status: selected product direction; proposed interfaces, not a running protocol or a second build queue. Canonical Yarvis scope and decisions: [master plan](master_plan.md), P13–P14 and D47–D48. S1 can ship independently. This document informs subsequent producer planning; it does not edit their current grants or authorize a run.

Coordination: [prompt for the active producer window](s2-coordination-prompt.md). Defer Yarvis S2 implementation until that work finishes and returns accepted contracts/revisions; then revalidate and plan the smallest integration slice.

## Intended journey

Open Yarvis on a phone, prepare one bounded project request, review the exact task and target in Ambition/Calibration, approve once, then return to Yarvis to monitor and open the accepted result. Losing the browser connection or reopening must find the same run, not launch another one. The initial integration targets one selected real project; arbitrary project dispatch follows only after separate qualification.

## Ownership

| Component | Owns | Does not own |
|---|---|---|
| Yarvis | Personal context, source-linked request draft, stable request identity/version, mobile-friendly entry, links and result projection | Forge attempts, native build acceptance, duplicate execution queue |
| Ambition/Calibration | Initial project/plan review and sole approval/dispatch control surface; authenticated bridge to Forge | Personal message store or independent acceptance verdict |
| Forge | Target/admission validation, bounded grant, attempt identity, lifecycle, cancellation and recovery; preserves native acceptance receipt | Treating a spawn or exit as proof of accepted work |
| Native build owner | Existing implementation/review acceptance decision and evidence | Granting new authority from a generated summary |

“Yarvis front door” permits a linked handoff to Calibration; it does not require duplicating its controls. Later embedding can preserve the same authority. Phone authentication is not established by responsive CSS.

## Pocket Relay disposition

The operator explicitly permits redesign or absorption. Default: absorb these requirements into the Yarvis/Calibration journey: dictated text is an editable draft; review exact content and target; bind approval to a version/hash; recheck before dispatch; report permission/capability holds; retain reviewed request and outcome.

Do not require the old standalone CLI, keyboard-button package or Remote Control transport for mobile web access. A native remote Claude session is a later optional capability. Keep the old repository and historical plan intact until its replacement is accepted; then reconcile its roadmap/issues as superseded/transferred in a scoped follow-up. Do not describe the unfinished CLI as an existing transport.

## Current producer evidence and gaps

Inspection on 2026-10-20: Forge's canonical plan records accepted Counter build b15, with a real-project item next. Its accepted implementation and the Calibration UI are on separately retained branches; integration must re-resolve actual accepted revisions at implementation time. A narrow Counter success does not qualify arbitrary repositories.

The existing Calibration source supplies mobile-oriented Approve & Go, progress/result/receipt UI and Counter-specific restrictions. Its bridge supplies authenticated status/submit/start and a local-launcher bootstrap. These are reuse candidates; the bootstrap is not a phone login solution. Current Forge post-B plans already select mobile Calibration access before remote Claude sessions. See producer plans: `swarm-forge/docs/plans/master_plan.md` and `pocket-relay/docs/plans/master_plan.md` in the sibling workspace repositories. Those repositories are not needed to build Yarvis S1; their relevant contracts are summarized here.

## Proposed minimum handoff (version 1)

This is a requirements schema, not a claim that these API fields already exist. The producer implementation must negotiate/validate one exact version; unsupported versions return a visible hold. No guessed private endpoints or shell interpolation from a chat message.

| Record | Required fields |
|---|---|
| Prepared request | `schemaVersion=1`; `requestId` UUID; positive `revision`; `instruction` text; `instructionHash` SHA-256 of exact reviewed UTF-8 text; `targetId` selected from producer-owned targets; `planPin` and `baselineRevision` immutable source references; `intendedOutput`; bounded `sourceRefs` with ID, capture time and approved excerpt |
| Approval binding | Authenticated approving identity and route, requestId/revision/hash, selected target/pins, allowed writes/effects, deadline, single submission nonce; producer validates it rather than trusting client JSON saying approved |
| Submission result | Producer submission ID and nullable attempt ID (opaque producer strings; attemptId is null until an attempt exists), correlated request identity, state, observation time, reason code, producer revision |
| Status/result | One of `pending_review`, `admitted`, `running`, `held`, `cancel_requested`, `cancelled`, `failed`, `finished_unaccepted`, `accepted`; result reference and native acceptance owner/receipt when applicable; explicit stale/unavailable observation separate from lifecycle state |

The final approval digest must bind the entire reviewed execution specification, not only instructionHash: target, source pins, effects and deadline are consequential too. Canonical encoding/hash rules are a producer qualification deliverable before S2 implementation, not an S1 blocker. Carry only source excerpts explicitly selected for project work; never forward whole inboxes, private settings or credentials. This data minimization requirement is separate from execution approval.

## Required behavior

- Same request identity/version and unchanged specification returns the existing submission. Conflicting content refuses with an explicit conflict; never silently dispatch twice.
- Changed draft/target/pins/effects after review invalidates approval. No browser checkboxes or imported email instructions grant execution authority.
- Yarvis only shows accepted when the producer supplies correlated native acceptance evidence. User-marked handled, draft-ready, process-finished and accepted remain distinct.
- Cancellation distinguishes request received from acknowledged process termination/settlement. Do not offer a working Cancel control until producer support is proven. Disconnect is neither cancel nor retry.
- Lost status access displays last observation and staleness; it must not rewrite an accepted outcome to failed or imply live progress.
- Current loopback Host/header checks are not remote authentication. Select one private phone transport, authenticated session mechanism, CSRF/origin protection and credential bootstrap during S2 planning. Refuse remote startup until configured; no public tunnel or unauthenticated LAN bind by default.
- Versioned adapters consume producer-owned contracts. There is one initial dispatch authority in Calibration and one execution lifecycle in Forge. No new generic scheduler is required for the first integration.

## Producer work that must precede integrated acceptance

1. Forge: qualify one server-owned real-project target and carry its identity/pins/effects through admission, execution and receipts; resolve the accepted implementation's durable source/install location.
2. Calibration: retain existing mobile controls, add the chosen private-phone authentication/bootstrap, support the exact approved request binding and reopen/status journey.
3. Yarvis: publish prepared request references through a narrow adapter and render producer-owned outcomes with stale-state handling. This work follows S1; S1 data entities need not pretend to be executable grants.
4. Pocket Relay: transfer useful requirements to the owners above; no standalone completion prerequisite. Reconcile historical queue after the replacement journey is accepted.

These are capabilities to plan in their owning repositories, not a requirement to complete their full backlogs.

## S2 acceptance gate

On a real phone over the selected authenticated private transport: open Yarvis, prepare/review one real-project task, dispatch once through Calibration, observe Forge, and return to the accepted artifact/evidence in Yarvis. Then prove unchanged resubmission does not duplicate execution, changed-content approval is rejected, cancellation is honestly acknowledged, and interrupted/reopened viewing recovers the same attempt. A mobile screenshot, Counter-only fixture, or successful process exit alone is not this gate. Keep S3 experiment work out of the dependency chain.
