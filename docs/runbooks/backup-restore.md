# Runbook — Backup and Restore (A.8.13, A.5.37)

> Covers the nightly backup of the production PostgreSQL 16 database and the attachment store, the
> full restore procedure, and the **quarterly restore test** with its sign-off record. A backup
> that has never been restored is a hope, not a control — the restore test is the acceptance test
> for A.8.13.
>
> Last updated: 2026-08-04. Owner: `TODO(client)` — named infrastructure engineer.

## Purpose

Recover the application database and attachment files after data loss, corruption, ransomware, or
host failure, within the RTO/RPO agreed with the client (`TODO(client)` — RTO/RPO to be defined
with the client before Phase 4 per plan §8.2, A.5.29/A.5.30; the design below assumes RPO ≤ 24 h
from the nightly cycle).

## What is backed up

| Item | Method | Schedule | Target |
|---|---|---|---|
| PostgreSQL database (all schemas incl. `audit_log`) | `pg_dump` custom format, encrypted by the backup platform | Nightly, during low-usage window | Dedicated backup host, separate from app and DB servers, with an immutable/offline copy (plan §2) |
| Attachment store (quotes/invoices directory) | File-level backup of the attachment volume | Nightly, same window | Same backup target |
| Server configuration (env/DPAPI config references, certificates) | Config backup per Massy IT standard | On change | Massy IT config store |

Backups are encrypted at rest; the backup encryption key is held by the backup platform under
Massy IT key custody (see `docs/CRYPTO.md` §2, §7). The backup service account is distinct from
the application service account (plan §2 ask-list item 6).

## Preconditions (backup)

- Backup service account exists with read access to the DB (via `pg_dump` role) and the attachment volume — no write access to production data.
- Backup target reachable per the plan §2 firewall table; immutable copy retention configured.
- Monitoring: a failed or skipped nightly job raises an alert to the operations channel (A.8.16 landscape).

## Nightly backup job (reference commands)

Executed on the DB host by the scheduled backup agent (paths per deployment; adjust to the provisioned layout):

```
# 1. Database dump (custom format, compressed)
pg_dump --format=custom --file=/backup/staging/purchasing_$(date -u +%Y%m%dT%H%M%SZ).dump \
        --dbname=purchasing --username=svc_backup

# 2. Checksum the dump
sha256sum /backup/staging/purchasing_*.dump > /backup/staging/purchasing_$(date -u +%Y%m%d).sha256

# 3. Attachment volume sync (verify mode)
robocopy D:\appdata\attachments \\BACKUP-HOST\purchasing\attachments /MIR /Z /LOG:C:\backuplogs\attach.log
#   (Linux deployment: rsync -a --checksum /srv/app/attachments/ backup-host:/purchasing/attachments/)

# 4. Hand off to the backup platform for encryption + immutable copy, then clear staging
```

## Restore procedure (production recovery)

**Declare first:** a production restore is an incident. Open an incident per
`docs/runbooks/incident-response.md` before proceeding, and get approval from the incident lead
plus the application owner (`TODO(client)` — named application owner).

1. **Stop the application** so no writes occur during restore:
   `Stop-Service MassyPurchasing` (or `systemctl stop massy-purchasing` on Linux).
2. **Identify the restore point.** Choose the newest dump at or before the loss event. Record the chosen file name and its UTC timestamp in the incident log.
3. **Verify backup integrity** before touching production:
   `sha256sum --check purchasing_<ts>.sha256`
4. **Restore the database** to a fresh database, then switch — never restore over the only copy:
   ```
   createdb --username=postgres purchasing_restore
   pg_restore --dbname=purchasing_restore --username=postgres --no-owner purchasing_<ts>.dump
   ```
5. **Verify the restored database** (see Verification below) while production DB is still untouched.
6. **Switch over:** rename databases (`ALTER DATABASE purchasing RENAME TO purchasing_failed_<date>; ALTER DATABASE purchasing_restore RENAME TO purchasing;`) or repoint the app connection string via config — per what the incident lead approves. Keep the failed database until the incident closes.
7. **Restore attachments** for the same point in time from the backup platform to the attachment volume.
8. **Cross-check attachments vs database:** every `attachments` row's `storage_key` must exist on disk and match its recorded `sha256`. Script the check; log misses in the incident record.
9. **Start the application**, confirm health endpoint, confirm login, then announce restoration in the incident channel.

## Verification steps (used in both real restores and quarterly tests)

1. `SELECT count(*) FROM requisitions;` and compare against the last known-good count from monitoring.
2. Most recent `audit_log` row timestamp is consistent with the chosen restore point.
3. **Audit chain verification job passes end-to-end** on the restored data (`row_hash` chain intact from genesis — see `docs/CRYPTO.md` §3). A restore that breaks the chain is a failed restore.
4. Application login works; a known requisition renders with its full approval trail and its attachments open and match their SHA-256.
5. Sample attachment hashes verified: `sha256sum <file>` equals `attachments.sha256`.
6. Record data loss window (last transaction in restored data vs loss event time) in the incident log.

## Rollback (restore went wrong)

- The pre-restore production database was renamed, not dropped — rename it back and repoint the app.
- If the restored data is wrong (wrong point in time), repeat from step 2 with a different dump; nothing destructive has occurred because restores always target a fresh database.
- If no usable backup verifies, escalate immediately (below) — do not improvise against the production volume.

## Quarterly restore test (A.8.13 — mandatory, dated, signed)

**Cadence:** before go-live, then every calendar quarter. **Never against production:** the test
restores into an isolated test host with **no network route to production** (A.8.31/A.8.22), using
test credentials only.

Procedure:

1. Pick the most recent nightly dump and the matching attachment backup.
2. On the isolated test host, run restore steps 3–5 and 7–8 above.
3. Run **all six verification steps** above; additionally time the end-to-end restore and compare against the agreed RTO.
4. Destroy the restored copy at test end (`dropdb purchasing_restore`; delete restored attachment files) — synthetic-data rules notwithstanding, restored production data must not linger on a test host (A.8.33 is about test *fixtures*; a restore test is a controlled, time-boxed exception, wiped on completion). `TODO(client)` — confirm this handling with the client's security lead.
5. Complete a row in the sign-off record below in the same change/commit.

### Restore test sign-off record

| Date (UTC) | Backup dated | Restore duration | Chain verification | Attachment check | Result (pass/fail) | Findings / follow-up | Performed by | Signed off by |
|---|---|---|---|---|---|---|---|---|
| *(none yet — first test due before go-live, Phase 4)* | | | | | | | | |

## Escalation contacts

| Role | Name | Contact |
|---|---|---|
| Infrastructure engineer (backup owner) | `TODO(client)` | `TODO(client)` |
| Database administrator | `TODO(client)` | `TODO(client)` |
| Application owner | `TODO(client)` | `TODO(client)` |
| Massy IT incident channel | `TODO(client)` — existing channel per plan §8.2 | `TODO(client)` |
