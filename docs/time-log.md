# Time log

Honest wall-clock record, as the brief requires. The core (PRs 1 to 3) is the
time-boxed deliverable. Everything after is logged as extras built beyond the
box. Times are local (ADT, UTC-3), taken from git commit timestamps and the
session ledger.

| Date | Phase | Start | End | Hours | Notes |
|---|---|---|---|---|---|
| 2026-10-17 | Design and planning (spec, plan, JD review, FigJam architecture diagram) | — | 15:24 | not measured by the agent; Herman records the actual span | Before the first commit |
| 2026-10-17 | Core: PR 1 scaffold, config, bootstrap, health, CI | 15:24 | 15:37 | 0.2 | 4 tasks, 2 review rounds |
| 2026-10-17 | Core: PR 2 storage, codes, bookings API, e2e harness | 15:37 | 15:59 | 0.4 | 4 tasks, 2 fix rounds |
| 2026-10-17 | Core: PR 3 outbox, dispatcher, transport, ack, guest device, e2e scenarios | 15:59 | 16:28 | 0.5 | 5 tasks, 5 fix rounds |
| 2026-10-17 | Extras: PR 4 ops API, metrics, alerts, demo | 16:28 | 16:46 | 0.3 | 4 tasks batched |
| 2026-10-17 | Extras: PR 5 Pub/Sub transport | 16:40 | 17:02 | 0.4 | Built in parallel with PR 6 |
| 2026-10-17 | Extras: PR 6 Dockerfile, README, decisions, diagram, whole-project review and final fix wave | 16:44 | 17:30 | 0.8 | 2 tasks batched, FigJam diagram by the main agent; review findings fixed in one pass |

Core subtotal (build only): 1.1 h, plus design and planning above. Extras subtotal: 1.5 h (sum of the rows; PRs 5 and 6 overlapped, so the wall-clock span 16:28 to 17:30 is 1.0 h).

Built with Claude Code driving one implementer and one independent reviewer per
task; every task's tests were written before its code.
