# Runbook — DOA Version Rollback (A.5.37, A.8.32)

> How to withdraw a bad Delegation of Authority matrix version and return to the previous rules —
> **without deleting anything**. DOA versions are never deleted, only superseded (plan §6.1); a
> rollback is performed by activating a **new** version whose content equals the prior good
> version. History stays complete, and requisitions submitted under the bad version keep their
> frozen `doa_rule_snapshot` (plan §4 design rule 1).
>
> Last updated: 2026-08-04. Owner: `TODO(client)` — DOA Administrator.

## Purpose

Restore correct approval routing quickly when an activated DOA version turns out to be wrong —
wrong thresholds, wrong approvers, overlapping/gapped amount bands that validation could not catch
(e.g. semantically wrong but structurally valid), or a version activated by mistake.

## Preconditions

- You hold the **DOA Administrator** role. Note the segregation constraints (A.5.3): the DOA
  Administrator cannot approve requisitions, and nobody can edit the DOA and approve against it in
  the same version.
- A second person holding the **Finance Director (activation approver)** role is available — every
  activation, including a rollback, is a two-person action (plan §6.1).
- You know: the bad version number, the last known-good version number, and the reason (you will
  be required to record it).

## Decide the blast radius first

Requisitions are affected differently depending on state; establish counts before acting:

| Requisition state | Effect of the bad version | Action |
|---|---|---|
| Submitted/in-approval **under the bad version** | Routed by the bad rules (frozen in their `doa_rule_snapshot`) | List them (logbook filter: DOA version = bad version, status = pending). After rollback, each must be individually **cancelled and re-raised**, or knowingly allowed to finish under the snapshot — decision recorded per requisition by the Finance Director. Never silently re-route in place; the snapshot is the audit truth. |
| Already approved/denied under the bad version | Decision stands on its frozen snapshot | No data change. If a decision was materially wrong because of the bad rules, handle as a business correction (new requisition / documented reversal), not a data edit. |
| Draft (not yet submitted) | None — rules freeze at submit | Nothing; they will submit under the reactivated rules. |

## Step-by-step rollback

1. **Record the trigger.** Note (incident ticket or change record) what is wrong with version
   `N` (bad) and that you intend to reactivate the content of version `G` (last good).
2. **Export version G's source file** from the app (DOA admin screen → version history → version G
   → download original `.xlsx`). Its integrity is verifiable: the app stores the file's SHA-256
   (`doa_matrix_versions.file_sha256`); confirm the downloaded file's hash matches.
3. **Re-upload that file as a new version** via the normal DOA upload flow (Admin → DOA matrix →
   Upload). It enters as **draft version N+1**. Do not attempt any direct database manipulation —
   there is no legitimate path that edits or deletes `doa_matrix_versions` rows, by design (A.5.33).
4. **Run the validation + diff screen.** The diff of N+1 against active version N shows exactly the
   bad changes being reversed. Screenshot or export the diff into the change record — this is the
   evidence of what the rollback changed.
5. **Submit for activation**, entering the reason: e.g. `Rollback of version N (defect: <one line>);
   content restored from version G`.
6. **Second person activates.** The Finance Director role reviews the diff and approves activation
   (two-person rule). On activation: N+1 becomes `active`, N becomes `superseded` with its
   `effective_to` set. Both actions are audit-logged automatically with actor, timestamp, and
   before/after (A.8.15).
7. **Handle in-flight requisitions** per the blast-radius table above; record the per-requisition
   decisions.
8. **Notify** affected requesters/approvers (Leasing pilot: department manager) that routing rules
   were corrected and which requisitions were re-raised.

## Verification

1. DOA admin screen shows: version N+1 `active`, version N `superseded`, version G `superseded` —
   **all three still present**. Nothing deleted.
2. Create a **draft** requisition in an affected category/amount band; the live routing preview
   ("This requires approval from: …", plan §5.1) shows the version-G chain again. Discard the draft.
3. `audit_log` contains the upload, submission, and activation events for N+1, and the chain
   verification job still passes.
4. Any requisition previously submitted under N still displays its original frozen snapshot (spot
   check one).

## Rollback of the rollback

The procedure is its own undo: if version N+1 is also wrong, repeat the steps re-uploading whichever
prior version's file is correct, producing version N+2. There is never a state where rolling
forward is unsafe, because no version is ever mutated or removed.

## Escalation contacts

| Role | Name | Contact |
|---|---|---|
| DOA Administrator | `TODO(client)` | `TODO(client)` |
| Finance Director (activation approver) | `TODO(client)` | `TODO(client)` |
| Application owner | `TODO(client)` | `TODO(client)` |
| Development support (validation defects) | `TODO(client)` — dev team contact | `TODO(client)` |
