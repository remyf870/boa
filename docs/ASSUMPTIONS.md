# Assumptions Register — Massy Motors Purchase Approval & DOA Enforcement App

> Maintained per plan §0.4: every assumption made without a client answer is recorded here with a
> `TODO(client)` marker instead of being silently chosen. This register is an input to plan §9
> (open questions) and to the A.5.31 legal/retention confirmation. Nothing in this file is a
> settled decision until the corresponding `TODO(client)` is cleared and the entry is moved to a
> dated "Resolved" section.
>
> Document owner: Development team. Review cadence: at every phase gate, and whenever a client
> answer arrives. Last updated: 2026-08-05.

---

## 1. Open questions from plan §9 — status table

| # | Question (plan §9) | Interim assumption used in the build | Status |
|---|---|---|---|
| 1 | **DOA content** — thresholds, approver roles, escalation paths | A realistic draft DOA matrix (synthetic, Leasing-shaped) is used for development and testing only. It is loaded as a normal versioned DOA upload so it is fully replaceable by the client's real matrix with no code change. No threshold is hardcoded anywhere (plan §0.3). `TODO(client)` | Awaiting client |
| 2 | **Currency** — single base or multi-currency with FX? Which base? | Single base currency **TTD** assumed. The `currency` columns exist throughout the schema, but validation rejects any currency other than the configured base; FX conversion and multi-currency budgets are deferred until the client answers. `TODO(client)` | Awaiting client |
| 3 | **Budget structure** — annual or quarterly? Cost centre only or cost centre × category? Carry-forward? | Budgets assumed **quarterly**, per **cost centre × category**, with **no carry-forward** of unspent amounts between periods. The `budgets` table carries `period` and `category_id` so any of the alternatives is a data/config change, not a schema change. `TODO(client)` | Awaiting client |
| 4 | **Approval routing** — sequential vs parallel; downward delegation? | Routing assumed **strictly sequential** (step N+1 does not open until step N approves, per plan §5.2). **No downward delegation**: an approver cannot approve at a lower level than the DOA requires. Peer delegation for absence cover is supported and records both identities. `TODO(client)` | Awaiting client |
| 5 | **CDK** — product, edition, hosting model; API/ODBC licensed and contractually permitted? | No live CDK integration in MVP (plan §6.5). The build captures CDK-shaped reference fields (`cdk_vendor_ref`, `gl_account_code`, `cdk_reference`) and produces an Excel batch export in CDK's expected column layout. Product/edition, hosting model, API/ODBC licensing, and contract permissions are **unknown**; Phase 2 integration design is blocked on these answers. `TODO(client)` | Awaiting client |
| 6 | **Retention** — how long must requisitions and invoices be kept (tax law + Massy Group policy)? | **7 years assumed for financial records pending legal confirmation.** This is recorded as a **question, not a settled answer** (A.5.31 requires the applicable law and retention obligations to be confirmed with the client's legal team — see §2.4 below). No purge/archival job is built until confirmed; nothing is deleted in the meantime (A.5.33). `TODO(client)` | Awaiting client |
| 7 | **Jurisdiction & data protection law** — which country's law; must data stay in-country? | **Trinidad & Tobago** data protection law (Data Protection Act) assumed to govern, and **data assumed to stay on-premises** inside the Massy network boundary. This drives the on-prem hosting default in plan §2 and interacts with Q12 (Power BI). `TODO(client)` | Awaiting client |
| 8 | **Entra ID** — will IT grant an app registration and Graph permissions? | App registration **not yet granted**. A **dev-mode authentication stub** is used in development only; it **refuses to run in production** (hard startup failure if `NODE_ENV=production`). All auth code is written against the OIDC authorization-code-with-PKCE flow so swapping in the real Entra registration is configuration, not code. This is a known go-live blocker (plan §2 ask-list item 4). `TODO(client)` | Awaiting client |
| 9 | **Emergency purchases** — break-glass path for urgent buys? | **Not built in Phase 0.** No emergency/retrospective-approval path exists yet. If the client wants one, plan §9 Q9 prescribes the shape (retrospective approval within 24 h, permanently flagged, reported monthly) and it will be designed deliberately in a later phase. Until then, out-of-hours purchases will surface on the Maverick Spend report. `TODO(client)` | Awaiting client |
| 10 | **Existing PO numbering** — align Approval Reference with an existing PO series? | Reference format `MM-<DEPT>-<YYYY>-<seq>` (e.g. `MM-LEA-2026-0001`) per plan §5.3, with `-APR` suffix on the approval reference. **Alignment with any existing Massy PO series is unconfirmed**; the generator is isolated in one module so the format can change before pilot without touching business logic. `TODO(client)` | Awaiting client |
| 11 | **Remote access** — can approvers act off-site; via VPN or Entra Private Access? | **Undecided — flagged.** Default position per plan §2 is none (office-only). Both candidate paths (existing corporate VPN vs Entra Private Access with Conditional Access) are documented; the app itself makes no assumption and requires no change either way. Must be settled **before go-live**. `TODO(client)` | Awaiting client |
| 12 | **Power BI hosting** — Power BI Service (cloud) or Power BI Report Server (on-prem)? | **Undecided — flagged.** If Power BI Service is chosen, requisition/budget data leaves the organisational boundary → A.5.23 assessment and a `/docs/THIRD-PARTIES.md` entry become mandatory, and this interacts with Q7 data residency. Reporting views will mask PII (A.8.11) in either case. `TODO(client)` | Awaiting client |
| 13 | **Budget approval authority** (plan §5.9) — who approves initial budgets and budget changes? One approval or a chain? | An org-wide **`budget_approver` role** is used; whoever the client names (Board of Directors is believed correct; possibly Finance Director for in-year changes) is granted the role — a data change, not a code change. Interim rule: **one approval by any budget_approver who is not the proposer** activates a budget version (two-person rule enforced by a DB CHECK). A multi-step chain, if required, is a follow-on change to the budget workflow only. `TODO(client)` | Awaiting client |

---

## 2. Build assumptions in detail

Each item below is what the build actually does today, and what changes when the client answers.

### 2.1 Currency — single base TTD
- Assumed: one base currency, **TTD**. All amounts (requisitions, budgets, DOA bands) validated against the configured base currency; mixed-currency comparisons never occur.
- Deferred: multi-currency, FX rates, FX-date policy.
- Impact if wrong: DOA band matching and budget arithmetic must define an FX policy; schema already carries `currency` columns so no migration is needed for storage.
- `TODO(client)` — confirm base currency and whether multi-currency is required (plan §9 Q2).

### 2.2 Budgets — quarterly, cost centre × category, no carry-forward
- Assumed: budget rows are per quarter, per cost centre × category; unspent amounts do **not** carry forward.
- `Available = Budget − Committed − Actual` is computed within the period only.
- `TODO(client)` — confirm period, granularity, carry-forward (plan §9 Q3).

### 2.2a Budget governance (plan §5.9) — approver identity, chain depth, commitment period
- Assumed approver: the org-wide `budget_approver` role (see §1 Q13). Seeded in dev to the
  synthetic Finance Director. One approval activates; two-person rule (proposer ≠ approver)
  enforced by a DB CHECK. `TODO(client)` — confirm the real party (Board of Directors?) and
  whether a multi-step chain is required (plan §9 Q13).
- **Commitment period rule (adopted):** an approved requisition **commits against the budget
  period containing its final-approval timestamp**; a posted invoice actualises in that same
  requisition's commitment period. Rationale: the approval is the moment spend authority is
  consumed. Alternative candidates (order date, delivery date, invoice date) are a
  calculation-level change only. `TODO(client)` — confirm the period-attribution rule.
- Live tracker semantics: `Committed` for a requisition = approved amount − amounts of its
  posted invoices (never below zero); the residue is released when the requisition closes or
  is cancelled. `Actual` = posted invoice amounts. Both are computed from base records on
  every read — no stored running totals that can drift.

### 2.3 Approval routing — strictly sequential, no downward delegation
- Assumed: sequential chain per plan §5.2; any denial ends the chain; denial reason mandatory; nothing is ever auto-approved.
- Not built: parallel approval levels; approving at a lower level than the DOA requires (downward delegation).
- `TODO(client)` — confirm routing semantics (plan §9 Q4).

### 2.4 Retention — 7 years assumed, **recorded as a question, not an answer** (A.5.31)
- Assumed working figure: **7 years** for requisitions, approvals, invoices, and their audit trail, pending confirmation by the client's legal team of the applicable tax law and Massy Group records policy.
- A.5.31's acceptance test is that this file records the **confirmed answer, not a guess** — that test is deliberately **not yet passed**; this entry exists precisely to keep it visible.
- Until confirmed: no retention-driven purge or archival exists; financial records are never hard-deleted regardless (A.5.33).
- `TODO(client)` — legal team to confirm retention periods and governing statute (plan §9 Q6).

### 2.5 Jurisdiction — Trinidad & Tobago, data on-prem
- Assumed: Trinidad & Tobago law governs; all production data (database, attachments, backups) stays on-premises inside the Massy corporate network.
- Interacts with: Q12 (Power BI Service would move data off-prem → A.5.23), and the Azure hosting alternative in plan §2 (not taken).
- `TODO(client)` — confirm jurisdiction and residency requirement (plan §9 Q7).

### 2.6 Reference numbering — `MM-<DEPT>-<YYYY>-<seq>`
- Assumed format per plan §5.3: `MM-LEA-2026-0001`, approval reference `MM-LEA-2026-0001-APR`.
- Sequence resets per department per year; generation is transactional (no duplicates under concurrency).
- Unconfirmed: whether Massy has an existing PO series the reference must align or interleave with.
- `TODO(client)` — confirm numbering alignment (plan §9 Q10).

### 2.7 Emergency purchases — not built in Phase 0
- No break-glass purchase path exists. This is a deliberate deferral, not an omission: plan §9 Q9 requires it to be designed deliberately (retrospective 24 h approval, permanent flag, monthly report) or people will route around the app.
- `TODO(client)` — decide whether the path is wanted and its rules (plan §9 Q9).

### 2.8 CDK — reference fields + Excel export only
- Per plan §6.5: no live integration. Reference fields captured; Accounting batch export produced in CDK's expected column layout.
- Unknown and blocking Phase 2: CDK product/edition, hosting model, whether an API integration platform is licensed, whether the contract permits integration, and who owns the vendor relationship.
- `TODO(client)` — Massy IT to answer the three questions in plan §6.5 (plan §9 Q5).

### 2.9 Entra ID — dev-mode auth stub until app registration granted
- The Entra ID app registration (redirect URI + Graph permissions) has not yet been granted by Massy IT.
- Development uses a clearly-marked **auth stub** (`AUTH_MODE=dev`) that signs in seeded synthetic users. Safeguard: configuration validation in `server/src/config.ts` rejects `AUTH_MODE=dev` whenever `NODE_ENV=production`, so the server **refuses to start** rather than run the stub in production (covered by `server/test/config.test.ts`). The stub only ever matches users whose identity is prefixed `dev-`, which real Entra provisioning never creates.
- All session, RBAC, and audit behaviour is identical under the stub, so nothing downstream changes when real Entra sign-in lands.
- `TODO(client)` — Massy IT to grant the app registration (plan §2 ask-list item 4, plan §9 Q8). **Go-live blocker.**

### 2.10 Entra disable propagation — bounded, not instantaneous
- Assumption recorded for auditor clarity: when IT disables a user in Entra ID, that user is locked out of this app at the **next token validation or session idle timeout — a maximum of 30 minutes** (the A.8.5 idle timeout) — not mid-request.
- Immediate revocation, when needed faster, is achieved in-app: revoking the user's role assignments takes effect **within one request** (A.5.18), and an admin can terminate active sessions.
- `TODO(client)` — confirm this propagation window is acceptable to Massy IT security, or fund session-revocation-on-Entra-webhook work.

### 2.11 Remote access path — undecided, flagged
- Neither VPN nor Entra Private Access has been chosen. The app assumes nothing; both options terminate at the same internal 443 listener. If Entra Private Access is chosen, the Conditional Access policy is a **required deliverable** (plan §2), owned jointly with Massy IT.
- `TODO(client)` — decide before go-live (plan §9 Q11).

### 2.12 Power BI hosting — undecided, flagged
- Cloud Service vs on-prem Report Server undecided. Reporting schema and masked views (A.8.11) are built the same either way; the choice only changes where data flows and whether an A.5.23 cloud-service assessment is triggered.
- `TODO(client)` — decide, tied to Q7 (plan §9 Q12).

### 2.13 Schema additions beyond plan §4 — operational tables
- Beyond the plan §4 tables, the schema adds: **`sessions`** (server-side session records: hashed token, CSRF token, idle/absolute expiry, revocation — required by A.8.5), banner-acknowledgement columns on **`users`** (`banner_acknowledged_at`, `banner_version` — required by A.5.10, recorded per user and re-required when the banner text changes), **`break_glass_account`** (the single A.5.17 emergency account: argon2id hash, encrypted TOTP secret, lockout state), **`reference_counters`** (gap-free §5.3 reference issuance), **`alerts`** (A.8.16 alert conditions), and **`schema_migrations`** (A.8.32 migration ledger).
- These are **operational necessities required by §8 gates, not scope creep**: each exists to make a named control's acceptance test passable.
- Recorded here so the deviation from §4 is explicit and reviewable. No other tables were added.

### 2.14 Design rule adopted: org-wide roles cannot be cost-centre-scoped
- `sysadmin`, `auditor`, `accounting` and `doa_admin` grants must always be organisation-wide
  (`cost_centre_id` NULL) — enforced by a DB CHECK and API validation. Rationale: a
  "cost-centre-scoped sysadmin/auditor" would satisfy org-wide role checks with over-broad
  effect (adversarial-review finding, 2026-08-04). §3's "roles per cost centre" continues to
  apply to `requester`, `approver` and `budget_owner`, which must be scoped.
- Also adopted from §3's role descriptions: a requester reads **their own** requisitions, not
  their whole cost centre's; cost-centre-wide read belongs to approvers (their centres) and
  accounting/auditor (org-wide). `TODO(client)` — confirm both rules match the intended DOA
  operating model.

### 2.15 Pre-release baseline: 2026-08-04 security hardening edited migrations in place
- The adversarial security review of Phase 0 led to fixes inside the existing migration files
  (audit chain v2, RLS policy rewrite, new constraints) rather than follow-up migrations.
  This is permissible **only** because no environment outside disposable dev/test databases had
  ever applied them — there was nothing deployed to migrate forward. From the first shared or
  production deployment onward, applied migrations are immutable and every change is a new file
  (A.8.32; the migration runner enforces this with recorded SHA-256 fingerprints).

### 2.16 Supabase — disposable dev/test database only
- A Supabase-hosted cloud Postgres instance is used **only** as a disposable development/test database, containing **synthetic data only** (A.8.33 — no production data ever exists to copy, and none will be copied when it does).
- Production is **on-prem PostgreSQL 16** per plan §2. The Supabase project will be **decommissioned before go-live** and is listed in `/docs/THIRD-PARTIES.md` with that status.
- No production secret, hostname, or credential is shared with the Supabase environment (A.8.31).

### 2.17 DOA engine resolution rules (Phase 1 build decisions)
- **Approver descriptors** in a DOA rule resolve only to ACTIVE users holding the **approver role
  for the requisition's cost centre** — a job title alone never grants authority (A.5.15).
- **Multiple candidates** for one descriptor: the engine deterministically picks the earliest
  approver grant (then user id), records the alternatives in the frozen snapshot, and flags the
  requisition (`multiple_candidates`). `TODO(client)` — confirm tie-break preference.
- **Self-approval** (A.5.3): the requester is skipped at that level and the skip is flagged; if
  the skips empty the chain, submission fails loudly (`unroutable_after_skips`) rather than
  routing wrongly. A person appearing at two levels approves once (first occurrence, flagged).
- **DOA activation role**: a dedicated org-wide `doa_approver` role (mapped to the Finance
  Director per plan §6.1). SoD makes `doa_admin` + `doa_approver` structurally impossible to hold
  together, so the two-person rule cannot be collapsed via role grants. `TODO(client)` — confirm
  the Finance Director mapping.

### 2.18 Phase 2/3 build decisions
- **Quotes** count toward the §5.1 gate only when their virus scan verdict is `clean`, and can be
  attached only while the requisition is a draft — what the approvers judged stays frozen.
- **Requisition closure**: a requisition closes when its posted invoice total reaches the approved
  amount; a partial posting leaves the remainder committed. `TODO(client)` — confirm.
- **xlsx magic-byte limit** (A.8.7): xlsx is a ZIP container, so the byte check admits any ZIP;
  import paths additionally require the file to parse as a real workbook, and everything is
  scanned before use either way.
- **Fiscal year start** is configurable (`fiscal_year_start_month`, default January = calendar
  year). `TODO(client)` — Massy Group's fiscal year (October start?) changes this one setting,
  no code.


### 2.19 Adversarial review of Phases 1–3 (2026-08-05) — decisions taken while fixing
A multi-agent adversarial review (six attack lenses, every finding independently refuted or
confirmed against the code) surfaced 21 confirmed defects. All were fixed in migration
`0010_review_fixes.sql` plus the corresponding routes, and each carries a regression test.
Three of the fixes embed judgement calls worth recording:

- **Invoice ceiling semantics.** Variance is now measured on the **cumulative** total of live
  invoices, not per invoice (previously N invoices each within tolerance could post N× the
  approved spend). A cumulative excess routes to variance re-approval per §5.4 — it is **not**
  refused outright, because refusing would make the plan's re-approval path unreachable. The
  database enforces the same rule: an invoice may only be `submitted`/`posted` above tolerance
  when a variance re-approval was actually **granted** for it. `TODO(client)` — confirm that
  re-approval (rather than a new requisition) is the right remedy for large overruns.
- **DOA validation: errors vs warnings.** A rule that can route in *no* cost centre is an error
  (upload refused). A rule that cannot route in *some* cost centres is a **warning**: it is shown
  to the uploader, shown to the second-person reviewer before activation, and recorded in the
  activation audit entry — but it does not block, because plan §1 pilots Leasing first and cost
  centres without approvers yet are expected. `TODO(client)` — confirm this is the wanted
  behaviour once the rollout goes beyond Leasing.
- **Budget periods are quarterly-only.** `FY2026` (annual) previously passed validation but could
  never match a requisition, so the budget was invisible while commitments accrued. Until §9 Q3 is
  answered, the CHECK and the API accept only the quarterly form the resolver produces. Supporting
  annual budgets means changing `fiscal_period_of`, the CHECKs and the API patterns together.

### 2.20 Workflow-consistency review (2026-08-06) — §6.1 reviewer visibility completed

A second multi-agent review walked every user journey end-to-end and independently verified
each finding against the code. The four confirmed DOA findings are fixed (each with a
regression test):

- §2.19's statement that routing-hole warnings are "shown to the second-person reviewer" was
  aspirational — the warnings lived only in the uploader's browser session. They now persist on
  the version itself (`0011_doa_reviewer_visibility.sql`, frozen once the version leaves draft),
  and activation is a full review screen (complete rule set, line-by-line diff vs the active
  version, and the recorded warnings) instead of a bare confirm dialog.
- DOA governance now notifies: every `doa_approver` when a draft is uploaded, and the uploader
  when their version is activated (`doa_submitted` / `doa_activated` — reference-only subjects
  per A.5.14).
- Server validation-issue lists (`issues[]` on 422s) now surface in the web client instead of a
  bare error slug, so an activator refused by revalidation sees the concrete problems and the
  remedy (corrected re-upload).

The same review confirmed 33 further findings across the budget, requester, approver,
accounting and navigation journeys (6 high severity). All six highs plus the cheap adjacent
fixes were closed the same day (migration `0012` + routes + web); the remaining confirmed
items live in `docs/KNOWN-GAPS.md` with severities and fix sketches. Judgement calls taken
while fixing:

- **Departed approvers: reassign at the moment of the admin action.** Disabling a user or
  revoking their approver grant now re-routes their pending steps to the next active user
  matching the step's FROZEN `doa_rule_snapshot` descriptor (same candidate ordering as the
  engine), inside the admin action itself — not via a sysadmin browsing surface, which A.8.2
  forbids. The mechanics live in a SECURITY DEFINER function (`0012`) that returns
  identifiers only, never amounts; a step with no eligible replacement raises an
  `approval_step_unassignable` alert instead of failing the admin action. The invoice
  variance path likewise skips inactive/role-revoked final approvers when creating the
  re-approval step.
- **Variance re-approval budget impact is the incremental excess.** The live position
  already carries the approved amount in `committed`, so the decide surface (and the
  `budget_remaining_at_decision` recorded on the step) now charges only
  `invoice − remaining commitment`, floored at 0 — previously it double-counted the
  requisition amount and never showed the invoice being decided.
- **In-app budget proposals start from the active budget.** The propose form prefills every
  category with its active amount (matching the Excel template); dropping a funded category
  is now an explicit, confirmed act instead of a silent zeroing on approval.
- **Ghost variance steps are hidden, not voided.** Queue and dashboard exclude variance
  steps whose invoice is no longer `pending_reapproval`; a proper `void` decision value is
  deferred (KNOWN-GAPS D4) because it needs an enum migration.

---

## 3. Resolved assumptions

*None yet. When a client answer arrives: record the answer, the date, who gave it, move the entry here, and update the affected code/config and `/docs/CONTROL-MATRIX.md` in the same change.*
