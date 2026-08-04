<!--
Massy Motors Purchase Approval & DOA Enforcement app.
This checklist enforces the compliance definition of done in
Massy-Motors-Purchase-Approval-App-Dev-Plan.md §8.3. A feature is NOT done
until every box is either ticked or recorded as an exception. Reviewers:
do not approve with unticked, unexplained boxes.
-->

## Summary

<!-- What does this PR change, and why? Link the plan section / issue. -->

## Compliance definition of done (plan §8.3 — all required)

- [ ] **1. Tests** — every feature/change in this PR has a test that exercises it (§8.3.1, A.8.29).
- [ ] **2. §8.1 controls checked** — I re-read plan §8.1 and checked this change against **every applicable control** (identity, data, files, logs, exports, approvals ⇒ it applies). List the controls touched:
  <!-- e.g. A.5.3, A.8.15 -->
- [ ] **3. Control matrix updated** — `docs/CONTROL-MATRIX.md` is updated with the control → code → test mapping for this change (§8.3.3, A.8.26).
- [ ] **4. Exceptions recorded, not skipped** — any control this PR could not satisfy is written down as an exception with a reason and an owner (§8.3.4). *No exceptions* is a valid answer; a silently skipped control is not.
  <!-- Exceptions (control ID, reason, owner), or "None": -->

## Security hygiene

- [ ] **No secrets in the diff** — no credentials, tokens, connection strings, or real personal data anywhere in this PR; gitleaks CI job passes (A.8.9).
- [ ] **Migrations are versioned, never edited in place** — schema changes are NEW migration files; no previously merged migration was modified (A.8.32). N/A if no schema change.
- [ ] **Configurable, not hardcoded** — no approval threshold, DOA rule, tolerance, or SLA value is a constant in code (plan §0.3). N/A if not applicable.

## Reviewer notes

<!-- Anything the reviewer should pay special attention to. -->
