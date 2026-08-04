# Runbook — Incident Response for the Purchase Approval App (A.5.37, A.8.16, A.5.28)

> App-specific incident procedure. It does **not** replace Massy's incident management process —
> per plan §8.2 (A.6.8, A.5.24–5.27), incident management is Massy's organisational control; this
> runbook plugs the app into it: what the app can detect, how to contain it, and how to pull
> defensible evidence out of it.
>
> **First rule: report into Massy's existing incident channel** (`TODO(client)` — channel name and
> on-call route) as soon as an incident is suspected. Then use this runbook for the app-specific
> steps.
>
> Last updated: 2026-08-04. Owner: `TODO(client)` — application owner.

## Purpose

Detect, contain, and collect evidence for security incidents involving the app: account compromise,
tamper attempts on the audit log, data exfiltration via exports, break-glass misuse, privilege
abuse, or a compromised app/DB host.

## Preconditions

- Access to the app as System Admin (or break-glass, per `docs/runbooks/access-provisioning.md`).
- DBA access to the production PostgreSQL host via the admin jump host (plan §2 — never direct
  from a user workstation).
- The incident channel reachable; incident lead identified.

## 1. Detection (A.8.16 alert conditions)

The app records — and, once Phase 4 wiring lands, alerts on — these conditions. Any one of them
firing starts this runbook:

| Signal | Meaning | First interpretation |
|---|---|---|
| Repeated failed logins | Password/token guessing or a confused user | Check source IP + target account; three or more distinct accounts from one IP = treat as attack |
| Privilege escalation (role grant to sensitive role) | Possibly legitimate admin work | Verify a matching ticket exists (access-provisioning runbook); no ticket = incident |
| Bulk export / abnormal export volume | Possible data exfiltration (A.8.12) | Identify exporter, filter, row counts from audit log; contact the user's manager |
| Out-of-hours admin activity | Possibly maintenance | Verify against change calendar; unannounced = incident |
| **Audit chain verification failure** | Tampering, data corruption, or restore fault | **Always an incident. Never dismiss.** |
| Break-glass account login | Emergency access used | Verify a declared incident/maintenance justifies it; otherwise incident |

Interim (before Phase 4 alert wiring): the on-call reviewer checks these signals in the audit log
daily via the admin view or DBA query. `TODO(client)` — confirm SIEM onboarding (plan §2 ask-list
item 8) so signals land somewhere a human reads.

## 2. Containment

Pick the mildest action that stops the harm; note everything you do, with UTC times, in the
incident channel.

**Compromised or suspect user account:**
1. In-app: revoke all role assignments and terminate sessions (effective within one request —
   access-provisioning runbook, Leaver steps).
2. Ask Massy IT to disable/reset the account in Entra ID (lockout within max 30 min token window;
   the in-app revocation covers the gap — ASSUMPTIONS §2.10).

**Suspected app-server compromise:**
1. Ask Massy IT to isolate the app server at the firewall (block workstation-VLAN → 443). The DB
   server is on its own VLAN with no outbound internet (plan §2) — leave it running for evidence.
2. Do not wipe or rebuild until evidence collection (§3) is complete.

**Audit chain verification failure:**
1. Freeze writes: stop the application service. The DB trigger blocking UPDATE/DELETE on
   `audit_log` means a break implies DBA-level access, a bug, or storage corruption — all serious.
2. Snapshot the DB (filesystem/VM snapshot) **before** any diagnosis.
3. Identify the first row where the chain breaks (verification job reports the seq); everything
   before it is still verifiable evidence.

**Export-based exfiltration:**
1. Contain the account (above). The audit log already holds who/when/filter/row-count for every
   export (A.8.12) — that is the scope of loss; export it as evidence.

**Break-glass misuse:**
1. Rotate break-glass credentials immediately (access-provisioning runbook); treat as account
   compromise of the highest privilege; review every action taken in the session via audit log.

## 3. Evidence collection (A.5.28)

Collect **before** remediation changes state. The audit log is designed to be defensible: append-
only, UTC-timestamped, actor + IP + user agent on every row, hash-chained (`docs/CRYPTO.md` §3).

1. **Audit export for the incident window:** filtered by time range and (if known) actor/entity,
   including `prev_hash`/`row_hash` columns. Via the app's audit export (Phase 3+) or, interim, a
   read-only DBA query spooled to file. Never via any tool that could write.
2. **Verify and record the chain** over the exported range: run the verification job, capture its
   output alongside the export. This is what makes the export tamper-evident rather than just a
   spreadsheet.
3. **Hash the evidence files** (`sha256sum` / `Get-FileHash`) and record the hashes in the incident
   channel at collection time — chain of custody starts here.
4. Collect app-server logs (application + auth events) and, via Massy IT, firewall/SIEM logs for
   the same window.
5. Store everything in the incident evidence location (`TODO(client)`), access-restricted.
6. All timestamps are UTC end-to-end (A.8.17) — correlate without conversion; state timezone
   explicitly in any narrative.

## 4. Eradication and recovery

- Account incidents: credentials reset in Entra by IT; in-app roles re-granted per
  access-provisioning runbook once cleared.
- Host incidents: rebuild from known-good baseline per Massy IT standard; secrets rotated
  (`docs/CRYPTO.md` §7 — DB credentials, Entra client secret, session signing key, break-glass).
- Data corruption/tamper: restore per `docs/runbooks/backup-restore.md`; the restore's chain
  verification tells you the restored history is intact.
- Vulnerability-driven incidents: patch per the A.8.8 pipeline — dependency fix, CI green,
  expedited deploy. Patch SLA: Critical/High within `TODO(client)` days of disclosure (documented
  patch SLA required by A.8.8 — confirm with client).

## 5. Post-incident

1. Write the incident record: timeline (UTC), signals, actions, evidence hashes, root cause, data
   affected and classification (A.5.12), loss window.
2. Feed lessons into: this runbook, alert thresholds (A.8.16), the control matrix
   (`/docs/CONTROL-MATRIX.md`) if any control failed — a control that failed silently is itself a
   finding under plan §8.3.4.
3. If personal data was affected: escalate to Massy legal/DPO for breach-notification assessment
   under the applicable data protection law (assumed Trinidad & Tobago, unconfirmed —
   `/docs/ASSUMPTIONS.md` Q7). `TODO(client)` — confirm the notification obligations and clock.
4. Verification of closure: alerts quiet, chain verification passing, no unexplained privileged
   activity for an agreed observation window.

## Rollback

Containment actions are reversible by design: role revocations are re-granted with lineage
(access-provisioning runbook), firewall isolation is lifted by Massy IT once cleared, a stopped
service is restarted after verification. Evidence is never rolled back — collected artefacts and
their hashes are retained per the incident policy and the (to-be-confirmed) retention schedule.

## Escalation contacts

| Role | Name | Contact |
|---|---|---|
| Massy incident channel (first call) | `TODO(client)` — existing channel per plan §8.2 | `TODO(client)` |
| Incident lead / security officer | `TODO(client)` | `TODO(client)` |
| Application owner | `TODO(client)` | `TODO(client)` |
| Massy IT identity team (Entra) | `TODO(client)` | `TODO(client)` |
| Database administrator | `TODO(client)` | `TODO(client)` |
| Development support | `TODO(client)` — dev team contact | `TODO(client)` |
| Legal / Data Protection Officer | `TODO(client)` | `TODO(client)` |
