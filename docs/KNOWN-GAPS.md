# Known gaps — verified findings not yet fixed

> Source: the 2026-08-06 workflow-consistency review (multi-agent, every finding independently
> verified against the code with file:line evidence — 37 leads judged: 31 confirmed, 6 partial,
> 0 refuted). The high-severity findings and the cheap adjacent ones were fixed the same day
> (commits `ddfd963`, `1cb704e` and the follow-up). The 2026-08-09 change-wave review's
> confirmed findings (12 confirmed + 5 verified leads) were all fixed in the wave commit;
> its deliberately deferred remainders are the **G** entries below. Everything here is
> **confirmed real, still open**, ordered by severity. Each entry carries the agreed fix
> sketch so no re-investigation is needed.
>
> Rules that bind any fix: new versioned migrations only (0001–0014 are applied/committed);
> audit append-only; configurable = data in `app_settings`; a fix without a regression test
> is not done.

## Medium

- **A1 — Stale DOA drafts are immortal and activatable.** No withdrawn/void state exists and
  activate has no version_no-vs-active guard, so an obsolete draft can supersede the current
  matrix (the new review modal at least shows the diff first). *Fix:* migration adding a
  `withdrawn` value to `doa_version_status` (+ permit exactly draft→withdrawn in the 0004
  immutability trigger), a withdraw endpoint + audit, refuse activation (409 `stale_draft`)
  when `version_no` < the active version's, hide Activate on stale drafts.
- **B2 — Budgets can only be proposed for the current quarter.** Purely a web limitation: no
  period picker (server accepts any `FY####-Q#`). *Fix:* period select on the propose modal
  (current + N future quarters; horizon in `app_settings`, labels computed via
  `fiscal_period_of`).
- **B3 — A rejected budget version is a rework dead-end.** No revise/clone; the Excel template
  prefills the *active* version, not the rejected one. *Fix:* "Revise and resubmit" button
  seeding the propose modal from `GET /api/budgets/versions/:id` (lines already returned).
- **B4 — Budget submit succeeds silently when zero approvers get notified.** Proposal strands
  in `pending_approval` with no fallback (the SLA job covers only requisition steps). *Fix:*
  abort submit with 422 `no_budget_approver_available` when the approver query is empty;
  extend `sla-reminders.ts` to budget versions stuck past the existing thresholds.
- **C2 — Draft editing is unreachable from the UI.** `PATCH /api/requisitions/:id` exists
  server-side; the UI offers no edit, so wrong amount/category means cancel + recreate. *Fix:*
  Edit button on draft detail opening the new-requisition modal prefilled, sending PATCH.
- **D3 — "All cost centres" delegation created without coverage warning** when the delegate
  cannot cover all the delegator's scopes (steps in uncovered cost centres silently covered by
  nobody). *Fix:* diff both users' approver scopes on create; return uncovered codes and
  surface them in the delegation form.
- **D4 (residual) — Ghost variance steps are hidden, not voided.** Queue + dashboard now
  exclude variance steps whose invoice is no longer `pending_reapproval`, but the step row
  stays `pending` forever and deciding it by direct link writes an audit entry with a null
  entity. *Fix:* migration adding a `void`/`obsolete` decision value set inside the accounting
  reject transaction, with audit.
- **D6 — SLA escalation is invisible and re-emails the same overdue approver.**
  `escalated_at` is rendered nowhere; escalation targets only the stalled assignee. *Fix:*
  select/render escalated state in queue + trail; make the escalation recipient configurable
  data (`app_settings`), e.g. next approver in the snapshot chain.
- **D7 — Variance re-approval steps are excluded from SLA reminders entirely** (the job
  filters `purpose='doa'` + `status='submitted'`). A stalled re-approval blocks posting with
  no reminder. *Fix:* second query branch for variance steps on approved/closed requisitions
  with the invoice still `pending_reapproval`; same thresholds and stamping columns.
- **D8 — Delegates are never notified; delegators cannot see on-behalf decisions.** No
  delegation templates exist. *Fix:* `delegation_created` (to delegate) and
  `decided_on_your_behalf` (to delegator, queued in the decide transaction) templates;
  optionally per-delegation decision counts on `GET /api/delegations`.
- **D11 — Workflow flags are recorded but rendered nowhere.** Self-approval skips, collapsed
  duplicates and multiple-candidate picks are in both step and requisition payloads already.
  *Fix:* render as notice chips in the decide modal and the requisition approval trail.
- **E3 — Batch export has no exported marker — double-keying risk into CDK.** Two clicks
  produce identical batches; the audit row has only a count. *Fix:* migration adding an
  append-only `invoice_exports` table (or `exported_at/by` stamp) written in the export
  transaction; badge already-exported rows in the queue; invoice ids in the audit payload.
- **E9 — SLA escalation never tells the requester their purchase is stuck.** *Fix:* also
  notify `requester_id` on escalation (`approval_stalled` template); recipients configurable
  in `app_settings`.
- **F1 (residual) — direct-URL routes are unguarded.** The sidebar now hides items by role
  and the Admin page gates its sections, but typing `/accounting` as a requester still mounts
  the page and 403s (writing an `AccessDenied` audit row per click). *Fix:* small
  `RequireRole` route wrapper in `App.tsx` rendering an access note instead of mounting.
- **G1 — Requisition-less attachment downloads are an app-level dead end.** The only download
  route (`GET /api/attachments/:id/download`) gates on uploader/requester/cost-centre, so for
  requisition-less files that reduces to the uploader alone: a `supplier_approver` cannot
  fetch the bulk-upload workbook their decision is based on (0014 fixed the RLS half — the
  read POLICY now admits them), and auditors/doa_admins hit the same wall on `doa_matrix` /
  `budget_import` evidence (pre-existing). Not blocking: the workbook's whole content is
  materialised into the pending supplier rows. *Fix:* make the route's app gate type-aware
  for requisition-less files (supplier_import → supplier_approver; doa_matrix/budget_import →
  their approver roles; auditor for all), expose `source_file_id` in `GET /api/suppliers`,
  link it from the admin supplier list.
- **G2 — Pre-provision residual: one human with two in-tenant Entra identities can defeat
  any two-person control.** The wave added the `allowed_email_domains` allowlist and a
  `pre_provisioned_role_claim` alert (critical when the claimed roles include
  supplier/budget/doa approver, accounting or sysadmin), so it is detectable — not
  preventable in code: identity dedup is an Entra-tenant property (`preferred_username` is
  mutable and guests carry home emails). *Mitigations:* tenant hygiene, periodic review of
  `claimedPreProvisioned` audit events against role grants, optionally an admin-UI
  confirmation ("this email will bind whoever signs in with it") on the Add-user form.

## Low

- **B5 (residual) — server 409s still carry only slugs.** The budget modal now refreshes and
  explains conflicts client-side; other surfaces map slugs ad hoc. *Fix:* include a human
  `message` alongside `error` on remaining 409/422 responses (client already prefers it).
- **C6 — Denied requisitions have no clone/resubmit path** (quotes not reusable in-app;
  files remain downloadable). *Fix:* "Clone as new draft" prefill or a small clone endpoint
  copying fields + clean quote attachments.
- **C7 — Quote requirement invisible on the draft detail page** (visible in the new-form
  preview and in the submit-failure message; not beside the Attach button). *Fix:* call the
  existing preview from the detail page and render "N required — M attached".
- **C8 — `type='other'` attachments have no UI path** (server accepts them on
  draft/submitted/approved). *Fix:* "Attach supporting document" button posting
  `{type:'other'}`.
- **C9 — Currency literal `TTD` hardcoded across the web UI** while the server treats
  `base_currency` as data. Latent while ASSUMPTIONS §2.1 pins TTD. *Fix:* expose
  `base_currency` in `GET /api/reference` and thread it through forms/labels.
- **D5 — Quotes/attachments not openable inside the decide modal** (one navigation away via
  the reference link). *Fix:* return clean attachments in the step detail and link them in
  the modal.
- **D10 — Delegation form is a bare email input** (server-side validation exists and is
  surfaced; no lookup/typeahead). *Fix:* small directory endpoint of active approver-role
  holders + typeahead.
- **E4 — Maverick Spend report has no in-app surface** (`reporting.v_maverick_spend` exists
  for BI; rows would indicate integrity failures only — blocked on ASSUMPTIONS Q5 for real
  CDK-side detection). *Fix:* accounting-visible report section + labelled export when the
  client answers Q5.
- **E6 — CDK reference and reject reason captured via `window.prompt`** (server validates
  length only; no format pattern for the reconciliation key). *Fix:* proper modal forms;
  validate `cdkReference` against a configurable pattern in `app_settings`.
- **E8 — Requisition cancellation notifies nobody** (a pending approver's emailed work item
  silently vanishes; no control bypassed). *Fix:* notify pending-step assignees (and, for
  approved requisitions, decided approvers) in the cancel transaction.
- **G3 — Suppliers remain outside RLS by design** (0006 reference-table posture). Their
  write-protection under the production role is now CHECK constraints + the 0014 state
  machine/no-delete triggers + app RBAC — adequate for rows that carry no financial detail,
  but if the posture ever tightens, add supplier RLS policies in a future migration.
- **G4 — Pending supplier requests are never re-notified.** All three request paths notify
  supplier approvers once; `sla-reminders.ts` covers only requisition approval steps, so a
  missed email leaves the request sitting until someone opens /admin (the pending-first
  banner mitigates). *Fix:* a pending-supplier branch in `sla-reminders.ts` reusing the
  existing threshold settings.
