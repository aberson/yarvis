# S1 build handoff

Run in `C:/Users/abero/dev/yarvis`. Read project/workspace instructions and verify current git state before proceeding. The operator approved this next build; do not restart the product-scope interview.

Read the master plan Phase 2 / S1, `s1-plan-review.md`, and `s1-assistant-proposal.html`. Planning used plan-feature for the existing project, followed by independent plan-review, plan-redline and plan-wrap. The review is READY. If code or scope has materially changed, reconcile that delta first.

## Prerequisite: issue binding

Invoke repo-sync on `docs/plans/master_plan.md`, scoped to S1 Steps 9–12 and M7–M8. Create/update the corresponding issues and backfill the Issue fields without closing or rewriting historical M5/M6 or issue #18. Commit and push the issue bindings. Do not create a build queue for S2 or S3. This prerequisite was deliberately left for the build session during closeout.

## Goal and build

After issue binding, set this agent-completable goal, then invoke build-phase:

    /goal Implement Yarvis S1 Steps 9–12 in docs/plans/master_plan.md through build-phase, pass their declared review and quality gates, land and push the changes, update progress/docs, and leave a precise M7–M8 live-acceptance handoff. Keep M7–M8 pending until observed; do not claim S1 user acceptance from fake-mode tests. Exclude S2/S3 and historical M5/M6/#18 from this goal.
    /build-phase --plan docs/plans/master_plan.md --steps 9,10,11,12

Use the host's native goal facility and installed build-phase skill when slash commands are not directly supported. Honor the skill's halt conditions; do not mark an unmet goal complete after a blocked gate.

## Constraints that must survive the handoff

- S1 journey: “brief me, then help me handle one request.” On-demand briefing and source-grounded editable drafts/checklists only; no message sending or project execution.
- Main checkout may be running the operator's live dev server. Follow the plan's worktree isolation and dedicated fake preview ports. Never print private runtime contents.
- Reuse existing Sheets/Claude/lock primitives as specified. Google Sheets remains Todo owner; SQLite under the private directory owns assistant state. Keep external fake tests distinct from the real local SQLite smoke and M7 real-service checks.
- Steps 9–12 are implementation work. M7 proves live service wiring; M8 proves the useful edit/save/restart/handled journey at the Desktop entry point. The old two-day M5 observation is separate.
- S2 waits for the other window's Ambition/Calibration + Forge handback. Use `s2-coordination-prompt.md` and `s2-integration-agreement.md` later; no producer dependency blocks S1. S3 stays backlog.
- Resume private intent continuity from local task state; preserve its existing record and no-progress history. Planning and handoffs did not advance runtime capability.
