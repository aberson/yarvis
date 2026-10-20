// Expected fake-mode totals (plan §5, Steps 6 and 8): the Todos / Quarantine tab row counts after ONE
// fake-mode Refresh (YARVIS_FAKE=1, settings.example.json) over the seeded FakeSheets. THE single
// source of truth for these counts: the pipeline integration test, the Playwright smoke and
// `npm run smoke` import it. Derived by hand from the fixtures (never computed by pipeline code):
//
//   Todos       5 seeded rows (sheet-seed.json)
//             + 3 new: gmail:19a0c0ffee000001#1, wa:...:3EB0FAKE000000000001#1,
//                      wa:...:3EB0FAKE000000000003#1 (jev-scores.json action >= 0.6, one action
//                      each in claude-responses.json)
//             (the seeded pending wa:15555550124@...#1 is retried in place, not added)  = 8
//   Quarantine  3 seeded rows
//             + 2 new: gmail:19a0c0ffee000002 (spam 0.93), gmail:19a0c0ffee000004 (phishing 0.97)
//                                                                                         = 5
// Not counted: gmail:19a0c0ffee000003 (clean, not actionable), 000005 (SPAM label), 000006 (before
// settings.since), and the non-allowlisted / non-text WhatsApp fixture events.
export const EXPECTED: { todos: number; quarantine: number } = { todos: 8, quarantine: 5 };
