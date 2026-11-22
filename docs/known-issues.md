# Known issues

What is known not to work, or not to be guaranteed, in the current tree, and every verification
failure seen since `check:all` existed, with what caused it and what was done. The README's
[Known limitations](../README.md#known-limitations) list the product's limits; this page keeps the
verification history and the tooling's limits visible. Run folders named here are kept under
`.run/check-all/<run id>/` on the machine that ran them (ignored by Git).

## Open issues

### Verification tooling (`check:all`, M6 Phase 1)

- **Only recorded applications are stopped.** When the `check:all` worker does not complete, the
  supervisor stops this run's four reviewer applications, each confirmed by its record, its token,
  as the only listener on its port and by its identity. It stops nothing else. Short-lived
  children of the worker (vitest, npm, the build, Chrome for the UI checks and benchmarks, the tests
  of failure detection's copies) are listed, never signalled: the supervisor names every process
  whose command line mentions the run's folder, its failure-detection copies or the UI benchmark's
  browser profile, with how to stop it by hand, and never reports child-process clean-up as
  complete.
- **Platform behaviour is not a guarantee.** On Windows, Node.js 22.21.0 was seen to end a child
  that is not detached, and that child's own child, when the parent ended by an uncaught exception
  (one experiment, on one machine). Nothing relies on it. On Linux and macOS such a child can outlive
  the worker; it is then listed as above.
- **A supervisor that is itself killed cleans up nothing.** The applications' records stay in the
  run's folder, so `npm run app:stop` with `TRADE_BLOTTER_RUN_DIR` set to the pair's folder still
  stops them after checking their tokens.
- **Failure detection's copies from a run that did not complete are kept.** A copy
  (`server/.test-build-check-<run>-<check>` or `client/.test-build-check-<run>-<check>`) may still be in use when the worker ends, so the
  supervisor names the run's copies and deletes none; another run's are never touched. Remove them
  by hand once nothing uses them.
- **Client failure detection uses the frontend's unit tests, not the browser.** The six client
  checks (M6 Phase 2) are detected by Vitest and jsdom tests with the real stores and a scripted
  API, after `vue-tsc` type-checks the changed copy. A defect that only layout, real input or the
  real API would reveal is caught by `check:ui` in `check:all`, which runs on the working source,
  not on mutated copies.
- **Ctrl+C and SIGTERM are tested through a stand-in signal source**, not a real console: Windows
  cannot send Ctrl+C to one process, and the tests' own process must not receive it.
- **Deadlines are fixed** (`STEP_DEADLINES_MS`, `PHASE_LIMITS_MS`, the supervisor's five-minute
  `GRACE_MS`). A machine where `review:05` or `review:06` takes over 45 minutes fails at the
  deadline.
- **The individual commands are not supervised.** `npm run review:06`, `perf:ui` and the other
  commands run alone still end at an error nothing caught, without their summary; their
  applications are then stopped with `npm run review:07`. `perf-ui.ts` still rejects requests
  outstanding when Chrome's connection closes, whether or not anything awaits them.
- **The documentation checks read three documents** (`README.md`, `docs/setup.md`,
  `docs/architecture.md`); this page and the [roadmap](roadmap.md) are not checked by `check:docs`.

### Application

The product's limits are in the README's [Known limitations](../README.md#known-limitations):
among them, there is no authentication (the actors are labels the server assigns), a booking cannot
give an execution time, Pending exposure is not shown by default, filtered counts are not faster,
`GET /trades` returns every trade at once, and the two dependency advisories are not assessed.

- **The API benchmark's dataset check sees Executed trades only.** `perf:api` and `review:06` stop
  when the trades change while they run, by comparing a fingerprint of the Executed trades; a
  Pending trade booked meanwhile (into the lists, but not the positions) is not noticed. It was so
  before M7, when Pending bookings were optional; with every booking Pending it matters more. Book
  nothing on the benchmark applications while they are measured (the browser checklist already says
  so).

## Verification failures and their resolutions

Every `check:all` run that did not pass, in order. No failed run's evidence was removed or
overwritten, and no failure was retried without a specific correction.

| Run | Milestone | What failed | Cause | Resolution |
| --- | --- | --- | --- | --- |
| `20261120T185222.175Z-1e7ad1` | M0 | `eslint-config.test.ts`, 5 s timeout (`review:05`) | The ESLint-ignore test ran past Vitest's default limit once | The server tests passed in the next run (`20261120T185832.606Z-0b344d`) |
| `20261120T185832.606Z-0b344d` | M0 | Documentation consistency | The Performance section did not name the application source fingerprint it was measured on | The fingerprint was added; `check:docs` compares it with the current source |
| `20261120T221728.906Z-a65767` | M3 | `trade-data.test.ts` (clearing: booking-sequence record 1000 where 500 was expected); the UI benchmark | The test's expected sequence record did not match what clearing kept; the benchmark failed once opening Chrome's `DevToolsActivePort` file (`EBUSY`) while another test run used the machine | Corrected before the next run (`20261120T222548.536Z-b8caaf`), where both passed; the `EBUSY` failure is intermittent and not ruled out |
| `20261120T232631.269Z-5cd9e3` | M4 | Four `docs-check.test.ts` tests | Their fixtures listed the routes before M4's `POST /trades/{id}/cancellation` | Fixtures updated for the new route |
| `20261120T234553.962Z-c96300` | M4 | `perf-api.test.ts` process-probe test, 5 s timeout | A PowerShell port probe slower than the default test timeout | The probe uses `netstat`; that one test allows 20 s |
| `20261121T004638.158Z-671c9a` | M4 | `test-isolation.test.ts` | `perf-api.test.ts` imported `node:child_process` directly | It goes through the isolating helper |
| `20261121T052103.723Z-1d7ea2` | M5 | The UI benchmark; the run itself | `perf-ui.ts` looked for Trade History's sort headers at their pre-M5 positions; a CDP request nothing awaited was rejected when Chrome's connection closed, and the unhandled rejection ended `check:all` with no summary and the four reviewer applications running | They were stopped by their tokens; header positions corrected |
| `20261121T053052.700Z-2d2689` | M5 | As above | As above | As above; M5 then passed (`20261121T132704.604Z-f85d41`) |
| `20261121T135702.791Z-877964` | M6 | A new `check-all-failures.test.ts` test | It checked a process by its bare id after a token-confirmed stop (`EPERM` while the process ended) | The test checks by token (`processStatus`) |
| `20261121T144350.160Z-af960e` | M6 | Failure detection's control for `audit-update-recorded-as-update` | `trade-audit.test.ts`'s trigger test exceeded 5 s in the unmodified copy: the first server composition in a process loads 241 CommonJS modules synchronously, and the machine's file access was slow at the time (imports 18.7 s instead of 1.3 s) | That test alone allows 15 s; its assertions and every other limit are unchanged |
| (no run folder) | M6 | `npm run check:all` exited at once with code 13, "unsettled top-level await" | Launcher import cycle: `check-all.ts`'s `main` imported the supervisor, which imports `check-all.ts` while it was still being evaluated, so each waited for the other | The entry point is `check-all-main.ts`, which nothing imports; `check-all.ts` starts nothing; `check-all-main.test.ts` runs the real entry point and npm in processes of their own |
| `20261121T185909.262Z-f3f411` | M6 | `test-isolation.test.ts`; the npm launcher test, 5 s timeout | The new supervisor and launcher tests and the stand-in worker imported `node:child_process` directly; npm starting under the full suite took over 5 s | Process creation goes through `test/support/child-process.ts` (new `finished`, `runCommand`, `npmCommand`, `startDetachedNode`), with no new exception to the isolation rule; the launcher tests allow 60 s each |

Earlier intermittent failure, outside these runs: on 2026-11-20, on Node.js 22.23.1, a reviewer
test's clean-up failed with `kill EPERM` after its own checks had passed; the clean-up was replaced
by confirmed termination and it has not recurred.
