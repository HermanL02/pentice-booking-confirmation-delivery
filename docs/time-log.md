# Time log

Honest wall-clock record, as the brief requires. The core (PRs 1 to 3) is the
time-boxed deliverable. Everything after is logged as extras built beyond the
box. Times are local (ADT, UTC-3), taken from git commit timestamps and the
session ledger.

| Date | Phase | Start | End | Hours | Notes |
|---|---|---|---|---|---|
| 2026-10-17 | Design and planning (spec, plan, JD review, FigJam architecture diagram) | — | 15:24 | _fill in_ | Before the first commit; Herman to record the actual span |
| 2026-10-17 | Core: PR 1 scaffold, config, bootstrap, health, CI | 15:24 | 15:37 | 0.2 | 4 tasks, 2 review rounds |
| 2026-10-17 | Core: PR 2 storage, codes, bookings API, e2e harness | 15:37 | 15:59 | 0.4 | 4 tasks, 2 fix rounds |
| 2026-10-17 | Core: PR 3 outbox, dispatcher, transport, ack, guest device, e2e scenarios | 15:59 | 16:28 | 0.5 | 5 tasks, 5 fix rounds |
| 2026-10-17 | Extras: PR 4 ops API, metrics, alerts, demo | 16:28 | _open_ | | 4 tasks batched |

Core subtotal (build only): 1.1 h, plus design and planning above. Extras subtotal: _running_.

Built with Claude Code driving one implementer and one independent reviewer per
task; every task's tests were written before its code.
