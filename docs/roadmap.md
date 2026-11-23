# Trade Blotter — Product Roadmap

## Purpose and status

This is the **re-baselined M1–M20 product roadmap**. It replaces the former engineering-oriented milestone list; the old milestone numbers and verification run IDs do not map one-to-one to these new numbers.

- **M1–M4: Delivered** under the new product-level grouping.
- **M5–M20: Planned**. Their inclusion here defines direction, **not authorization to implement**.
- Existing code may already provide parts of a future milestone. Before each milestone, inspect the implementation, identify the actual gap, and agree on acceptance criteria rather than duplicating functionality.
- Maintain the existing trade lifecycle, auditability, exact-decimal accounting, safe migrations, automated verification, and local-only Git workflow. Do not push unless separately authorized.

## Delivered — M1 to M4

| Milestone | Name | Delivered scope |
| --- | --- | --- |
| **M1** | Initial Development — Trade Blotter (Trades & Positions) | Foundational trade capture and Trade Blotter; Buy/Sell trades, position calculations, average cost, domain rules, API, persistence, and initial UI. |
| **M2** | Trade History | Historical trade listing and details, lifecycle statuses, trade timestamps, and the ability to inspect recorded activity. |
| **M3** | Search, Sorting & Paging | Trade History search and filters, column sorting, paging, and supporting data-access/performance improvements. |
| **M4** | Trade Cancellation & Auditing | Pending-to-Cancelled lifecycle with reason and confirmation; distinct cancellation records, immutable audit history, actor/timestamp recording, and integrity/concurrency protections. Existing Pending-to-Executed behavior is retained as part of the current application baseline. |

## Planned product milestones — M5 to M20

| Milestone | Name | Planned outcome |
| --- | --- | --- |
| **M5** | UI Usability | Unified Trade Details popup with Execute/Cancel actions and audit timeline; exact security-symbol matching; Positions search, sorting and exact-match option; consistent filter reset. |
| **M6** | Authentication, Login & Logout | User accounts, sign-in/sign-out, session management, an initial administrator and forced password change on first login; passwords stored as individually salted, adaptive hashes. |
| **M7** | User Management, Roles & Claims | Administrator-managed users, roles and permissions/claims (including `CanTrade` and `CanExecute`), plus a User Profile screen showing assigned roles and effective permissions. |
| **M8** | Pending Trade Amendments | Allow authorized amendments to a **Pending** trade's quantity, price and eligible attributes while retaining before/after audit records and enforcing position limits. |
| **M9** | Executed Trade Corrections & Reversals | Correct an Executed trade through linked, auditable reversal/replacement records instead of rewriting the original execution history. |
| **M10** | Pending & Projected Exposure | Display PendingNet and ProjectedNet separately from actual ExecutedNet; extend status-based trade search and Positions search/filter views. |
| **M11** | Security Master — Initial | Create a security reference master covering all securities used by the application; backfill existing trade symbols; validate that new trades reference an active, valid security. |
| **M12** | Security Picker & Enrichment | Security Master lookup/picker when booking; additional security attributes shown in Positions and Trade Details. |
| **M13** | Price Master & Close-of-Business Prices | Maintain historical, effective-dated security prices; initially derive COB reference prices from available trades using a documented rule, and allow booking-price selection from the Price Master. |
| **M14** | Account Master & Portfolios | Model accounts, portfolios and their relationships; associate trades and positions with the appropriate account/portfolio and support portfolio-scoped views. |
| **M15** | Custodians & Brokers | Reference masters and relationships for executing brokers, clearing brokers and custodians; associate them with accounts and trades. |
| **M16** | Pre-Trade | Portfolio decisions, order staging, liquidity/compliance controls, and pre-trade risk or credit limits. |
| **M17** | Front Office / Execution | Order routing and capture of venue, algorithmic or voice executions, including execution details and controlled handoff into trades. |
| **M18** | Middle Office | Trade enrichment, validation, allocations, lifecycle events, amendments/cancellations, and P&L/risk monitoring. |
| **M19** | Back Office | Confirmations, clearing, collateral, settlement, accounting entries and regulatory-reporting workflows. |
| **M20** | Gain & Loss Calculations | Realized and unrealized gains/losses by security, trade, account and portfolio, with explicit cost-basis, mark-price and valuation-date policies. |

## Scope notes and design decisions

### M5 — UI Usability

- Offer one **View Details** entry point, showing full trade information, status, available actions and audit history. Pending trades can be executed or cancelled with explicit confirmation; terminal trades are read-only.
- Support exact-symbol matching in Trade History and Positions. Positions sorting must operate on the displayed **ExecutedNet (actual position)** and average cost.
- Provide **Clear All Filters**; preserve keyboard accessibility and responsive layouts.
- Existing search/filter functionality may be reused. Copy Trade ID and remembering filters remain optional backlog items unless approved for M5.

### M6–M7 — Identity and authorization

- **Requested bootstrap:** an initial local administrator account with username `admin` and temporary password `admin`. Treat this as a **development-only, one-time bootstrap credential**, not a production-safe password. Force a password change on the first successful login *before* any protected action; never allow the default password in a deployed environment. Production bootstrap must use a separately supplied secret.
- Store only a per-user salted password hash using a well-established adaptive password-hashing scheme; never store or log plaintext passwords or invent custom cryptography.
- Provide safe session handling, logout/invalidation, input validation, and sensible login abuse controls. Server endpoints enforce authorization; UI visibility alone is not a security boundary.
- Model Users, Roles, Claims/Permissions, and user-role and role-claim relationships. Candidate claims include `CanTrade`, `CanExecute`, `CanCancel`, `CanAmend`, `CanViewAudit` and `CanManageUsers`; finalize the authorization matrix during M7 design.
- The existing `User`/`Admin` audit labels are not verified identities today. Replace or qualify those labels once real sign-in is implemented, while preserving historical records.

### M8–M10 — Trade lifecycle and exposure

- **M8:** Only Pending trades are amendable. Preserve prior values in the audit trail, reject stale/concurrent updates, and revalidate applicable limits.
- **M9:** An Executed trade remains historically immutable; reversals/corrections must be explicitly linked and produce correct subsequent position/cost results. Define correction, reversal and replacement semantics before implementation.
- **M10:** `ExecutedNet` remains the actual position; `PendingNet` is outstanding potential exposure; `ProjectedNet = ExecutedNet + PendingNet`. Existing backend calculations may be reused, while the user-facing exposure views and advanced status-aware search are developed here.

### M11–M15 — Reference data and organizational structure

- **M11:** “All securities” means the complete set of securities the application can book, including a safe legacy-symbol backfill—not an assumption that every security worldwide can be preloaded. Define identifiers, unique keys, active/inactive status and validation policies.
- **M13:** A price inferred from trades is a **derived reference mark**, not necessarily an official market closing price. Capture source, timestamp, pricing rule, and effective/as-of date; define precedence and missing-price behavior before changing booking defaults.
- **M14–M15:** Define default handling for historical trades that have no account, portfolio, broker or custodian; do not silently misattribute them.

### M16–M20 — Extended institutional workflows

- These build on the earlier trade-capture, identity, security, price and account foundations. They extend the system toward an end-to-end investment-operations workflow, not a claim of live connectivity to brokers, venues, clearinghouses or regulators.
- **M20:** Decide lot-selection/cost-basis rules, realized versus unrealized treatment, reporting currencies, FX conversion, COB marks and valuation cutoffs before implementing figures.

## Delivery expectations for each future milestone

1. Review existing code and document the gap, dependencies, compatibility implications and acceptance criteria **before implementation**.
2. Preserve historical trades and audit records; use safe, verified migrations where needed.
3. Add domain, API, database, client and browser tests appropriate to the change, with failure-path and concurrency coverage when relevant.
4. Run focused development verification (`check:fast`) and the comprehensive acceptance workflow (`check:all`) before declaring a milestone complete; distinguish platform-specific skips and benchmark warnings from failures.
5. Refresh documentation, OpenAPI/contracts and screenshots when affected, and record remaining limitations.
6. Use local commits only when approved; **never push** without separate authorization.

## Future usability backlog (not automatically included in M5)

- Copy Trade ID.
- Remember filters and sorting across tabs/sessions.
- Additional Pending/Projected exposure visualizations beyond M10.
