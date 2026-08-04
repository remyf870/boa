# Runbook — Access Provisioning: Joiner / Mover / Leaver (A.5.37, A.5.16, A.5.18)

> How users get, change, and lose access. Identity lives in **Microsoft Entra ID**; authorisation
> (role × cost centre) lives **in the app**. The two halves are deliberately split: Entra answers
> "is this a current Massy employee who can sign in", the app answers "what may they do here".
> Includes the quarterly access review export (A.5.18).
>
> Last updated: 2026-08-04. Owner: `TODO(client)` — System Admin.

## Purpose

Ensure access rights are granted with lineage (who, when, why), changed promptly on role change,
revoked immediately on exit, and reviewed quarterly with evidence.

## Model

- **Authentication:** Entra ID SSO (OIDC + PKCE). No local accounts except the single documented
  break-glass admin (see §Break-glass below). The app inherits Massy's MFA, conditional access,
  and joiner/mover/leaver process (plan §2).
- **Authorisation:** roles are assigned **per user per cost centre** in the app (plan §3):
  Requester, Approver, Accounting, Budget Owner, DOA Administrator, Auditor, System Admin.
  Every grant records `granted_by`, `granted_at`, and the reason; revocation sets `revoked_at` —
  rows are never deleted (A.5.18, A.5.33).
- **Segregation constraints enforced in code** (A.5.3) — the app will refuse conflicting grants:
  System Admin cannot hold Approver or Budget Owner; DOA Administrator cannot hold Approver;
  Accounting cannot hold Approver.

## Joiner

Preconditions: the person exists in Entra ID (IT onboarding complete); a written/ticketed request
from their manager states which role(s) and which cost centre(s), and why.

1. System Admin signs in → Admin → Users. First sign-in of the user auto-provisions their `users`
   row from the Entra token (object ID, name, work email, job title); alternatively the admin
   pre-adds them by work email.
2. Admin → Role assignments → Grant: select user, role, cost centre. Paste the ticket reference
   into the reason field. Submit.
3. Repeat per role × cost centre. The app blocks segregation-violating combinations — if blocked,
   the request itself is wrong; do not look for a workaround.
4. The grant is audit-logged automatically (actor, timestamp, before/after — A.8.15).

Verification: user signs in, acknowledges the acceptable-use banner (A.5.10 — required before any
data is reachable), sees exactly the expected cost centre(s); attempt to open another cost
centre's requisition by ID yields 404/403 (A.5.15 acceptance test).

## Mover (role or cost-centre change)

1. Grant the new assignment first (as Joiner steps 2–3), citing the ticket.
2. Revoke the old assignment: Admin → Role assignments → Revoke. **Revocation takes effect within
   one request** — the RBAC check reads current assignments per request; no logout is needed
   (A.5.18 acceptance test).
3. Check in-flight work: pending approval steps assigned to the user in the old cost centre are
   listed on revocation — reassign them via the DOA chain (next eligible approver) or delegation.
   Never leave orphaned pending steps.

Verification: user's next request under the old role/cost centre is refused; audit log shows both
the grant and the revocation with the ticket reference.

## Leaver

Two independent locks; use both, in this order:

1. **In-app (immediate):** revoke **all** role assignments (Admin → Users → user → Revoke all,
   citing the leaver ticket) and terminate the user's active sessions. Effective within one
   request.
2. **Entra (authoritative):** Massy IT disables the account per their standard leaver process.
   Propagation note (recorded in `/docs/ASSUMPTIONS.md` §2.10): Entra disablement locks the user
   out at the next token validation / session idle timeout — **maximum 30 minutes** — which is why
   step 1 exists for immediate effect.
3. Reassign pending approval steps as in Mover step 3.
4. The user's history (requisitions raised, decisions made) remains untouched — records are never
   deleted (A.5.33); the `users` row is marked inactive, never removed.

Verification: user's session is terminated; role list for the user shows all rows with
`revoked_at` set; a pending-steps query for the user returns none.

## Quarterly access review export (A.5.18)

Cadence: every calendar quarter, and on demand for audit.

1. System Admin → Admin → Access review → Export. The export lists **every user** with: status
   (active/inactive), each role, each cost centre, `granted_by`/`granted_at`/reason, `revoked_at`
   where set, and **last login** (UTC).
2. The export is itself audit-logged (who exported, when, row count — A.8.12) and carries the
   classification label (A.5.13).
3. Send to the reviewing manager per cost centre and the application owner. Each reviewer confirms
   every listed right is still required, or names the revocations needed.
4. Execute revocations per Mover step 2 within 5 business days. `TODO(client)` — confirm the SLA.
5. File the export + reviewer confirmations in the compliance evidence store
   (`TODO(client)` — location) — this is the A.5.18/A.5.36 evidence pack.

*(Until the export feature ships in Phase 4, the interim source is a read-only SQL query over
`users` + `roles_assignments` + session last-seen, run by the DBA and delivered as a dated file —
the review itself must not wait for the feature.)*

## Break-glass account (A.5.16, A.5.17)

- Exactly **one** local emergency admin account exists, for use only when Entra ID sign-in is
  unavailable. Password (argon2id-hashed in the app) and TOTP secret live in the client's vault
  (`TODO(client)` — vault location and custodians; two-person retrieval recommended).
- Every break-glass login raises an alert and is prominently audit-logged. Any use outside a
  declared incident is itself an incident (see `docs/runbooks/incident-response.md`).
- After each use: rotate the password and TOTP secret, re-store in the vault, record the reason in
  the incident log.

## Rollback

- Wrong grant: revoke it (lineage of both actions is preserved automatically).
- Wrong revocation: issue a fresh grant citing the correcting ticket — `revoked_at` is never
  cleared; the history stays true.
- Segregation block believed wrong: it is enforced in code (A.5.3) — raise with the development
  team; never work around it with a second account.

## Escalation contacts

| Role | Name | Contact |
|---|---|---|
| System Admin (app) | `TODO(client)` | `TODO(client)` |
| Massy IT identity team (Entra) | `TODO(client)` | `TODO(client)` |
| Application owner | `TODO(client)` | `TODO(client)` |
| Break-glass vault custodian | `TODO(client)` | `TODO(client)` |
