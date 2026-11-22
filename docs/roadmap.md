# Roadmap

What has been delivered, milestone by milestone, and what is planned. Anything under
[Planned](#planned) is **not implemented**: the application does not behave that way today, and
the README describes only what it does. Open issues are in [Known issues](known-issues.md).

## Delivered

| Milestone | What it delivered | Verified by `check:all` run |
| --- | --- | --- |
| M0 | Node.js 22.21.0 as the only supported version (`engines`, `review:01`); the `check:all` harness on ports of its own | (runs of 2026-11-20) |
| M1 | Confirmed termination: a process is stopped only when its record, token and port confirm it, with bounded waits | (runs of 2026-11-20) |
| M2 | Trade lifecycle rules in the domain only: statuses, the actors, booking, cancellation as two rows, positions by status and the position-limit rules, not yet stored, served or shown | (runs of 2026-11-20) |
| M3 | Trade lifecycle columns (status Pending, Executed or Cancelled; created and updated by), the `trade_audit` table and triggers, partial indexes on Executed trades | `20261120T225357.760Z-b9f9a0` |
| M4 | The lifecycle API: logical trades, cancelling a Pending trade (`POST /trades/{id}/cancellation`), audit history, the partial unique index on `original_trade_id`, then the four logical-trade indexes | `20261121T025603.935Z-2ca1cf`, `20261121T044001.281Z-0c3b74` |
| M5 | The page's lifecycle: the Status column and filter, Pending and Executed nets (the Pending and Projected net were removed from the page in M6 Phase 2), cancelling from Trade History and Trade Details, the audit timeline | `20261121T132704.604Z-f85d41` |
| M6 Phase 1 | `check:all` reliability: a supervisor process that starts and watches the worker; unhandled rejections recorded as failures; an uncaught exception ends the worker and the supervisor cleans up and reports; step and hard deadlines; summary validation; the launcher import-cycle correction; the test-isolation corrections | `20261121T224220.379Z-5ba089` |
| M7 | The complete lifecycle: every new trade booked Pending (Executed and Cancelled bookings and any execution time refused); execution as a separate operation, `POST /trades/{id}/execution`, updating the trade's own row in one transaction at the server's time, refused for Executed and Cancelled trades and at the Executed position limit; Execute in Trade History and Trade Details with a confirmation dialog; the page showing the actual position (Executed net and average cost) | `20261122T001837.885Z-cd5afd` |
| M6 Phase 2 | Client-side failure detection: checks can mutate the frontend (`workspace: 'client'`) on a copy under `client/`, type-checked with `vue-tsc`, each detected by the frontend's own tests (6 client checks beside the 31 server ones); the Positions UI without the deferred Pending and Projected net (backend calculations, API fields and the booking limit unchanged) | `20261122T011915.335Z-3961c7` |

## Planned

### Verification tooling (candidates only, not authorized)

M6 Phase 2 delivered client-side failure detection (see [Delivered](#delivered)). These
improvements to the tooling were left out of M6:

- Stopping a worker's short-lived children (vitest, npm, Chrome, failure detection's copies) after
  a crash, which needs an ownership model for them first; today they are listed, never stopped.
- Supervising the individual commands (`review:06`, `perf:ui` and others) as `check:all` is.
- `perf-ui.ts` not rejecting CDP requests that nothing awaits when Chrome's connection closes.
- Removing a crashed run's failure-detection copies once they are confirmed unused.
- `check:docs` reading this page and [Known issues](known-issues.md) as well.

### Deferred from M7 (not implemented; candidates only)

M7 delivered Pending-first booking and execution (see [Delivered](#delivered)); these were
deliberately left out of it:

- **Authentication and authorization.** The actors recorded are labels the server assigns to each
  operation (User books and executes, Admin cancels). Real sign-in, User and Admin roles, and
  executing or cancelling only when allowed need a design of their own (the M7 design's options
  C2, configured tokens, and C3, accounts and sessions, are a starting point).
- **Pending exposure.** The API still calculates the Pending Net (outstanding potential exposure)
  and the Projected Net (Executed plus Pending), and the booking limit still uses the projected
  position; since M6 Phase 2 the page shows neither. Showing them again, or building on them (an
  exposure view, limits per user), is deferred.
- **Execution details.** A client-given execution time (for example, a fill reported later), partial
  executions and execution prices other than the booked price are out of M7's scope: a trade is
  executed whole, at its booked price, at the server's time.
