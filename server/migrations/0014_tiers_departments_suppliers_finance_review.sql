-- 0014: the 2026-08-08 client change wave ("Changes to make to BOA app" +
-- MML DOA Framework draft v1, IMP 26302). Four related changes:
--
--   1. DOA approver TIERS — the client's operating model is tiered (Tier 5 =
--      supervisors/first-line managers, Tier 4 = senior managers/VPs, Tier 3 =
--      executive) rather than job-title-driven. A tier attribute on approver
--      grants lets DOA rules route "tier:5 → tier:4 → tier:3".
--   2. DEPARTMENTS — users get a home department (a cost_centres row; the UI
--      now presents cost centres as departments, one per department).
--   3. SUPPLIER approval workflow — suppliers are requested (Tier 5+) and
--      approved (supplier_approver, two-person rule) before becoming usable.
--   4. ACCOUNTS FINAL REVIEW — every requisition chain ends with a
--      'finance_review' step decided by the org-wide accounting role ("the
--      final hurdle"), enforced by the state machine, configurable via
--      app_settings.accounting_final_approval. Accounting is barred from the
--      requester role (SoD): the vetoing body must have no incentive to spend.

-- ── 1. Approver tiers ────────────────────────────────────────────────────────
ALTER TABLE roles_assignments ADD COLUMN tier smallint;
ALTER TABLE roles_assignments ADD CONSTRAINT tier_only_for_approvers CHECK (
  tier IS NULL OR (role = 'approver' AND tier IN (3, 4, 5))
);
COMMENT ON COLUMN roles_assignments.tier IS
  'DOA tier of an approver grant: 5 = supervisors/first-line managers, 4 = senior managers/VPs, 3 = executive. NULL on non-approver grants (and on legacy approver grants, which match no tier descriptor).';

-- ── 2. Home department ───────────────────────────────────────────────────────
-- The UI presents cost_centres as departments (one row per department going
-- forward); a user's home department is display/attribution only — authority
-- still flows exclusively from roles_assignments (A.5.15).
ALTER TABLE users ADD COLUMN home_cost_centre_id uuid REFERENCES cost_centres (id);

-- ── 3. Supplier approval workflow ────────────────────────────────────────────
-- Existing rows (admin-created before this migration) stay 'active'; new
-- requests enter as 'pending_approval'. Two-person rule mirrors budgets/DOA.
ALTER TABLE suppliers DROP CONSTRAINT suppliers_status_check;
ALTER TABLE suppliers ADD CONSTRAINT suppliers_status_check CHECK (
  status IN ('pending_approval', 'active', 'rejected', 'inactive')
);
ALTER TABLE suppliers
  ADD COLUMN requested_by     uuid REFERENCES users (id),
  ADD COLUMN requested_at     timestamptz,
  ADD COLUMN requested_reason text,
  ADD COLUMN approved_by      uuid REFERENCES users (id),
  ADD COLUMN approved_at      timestamptz,
  ADD COLUMN rejected_by      uuid REFERENCES users (id),
  ADD COLUMN rejected_at      timestamptz,
  ADD COLUMN rejection_reason text,
  ADD COLUMN source_file_id   uuid REFERENCES attachments (id);
ALTER TABLE suppliers ADD CONSTRAINT supplier_two_person_rule CHECK (
  approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by
);
-- Status must carry its evidence (mirrors budget_active_requires_approval /
-- budget_rejection_is_complete, 0008). Without these, a single UPDATE could
-- mint an 'active' supplier with no approval on record, or a 'rejected' one
-- with no reason (adversarial-review finding). Rows that predate this
-- migration were admin-created and stay 'active' with requested_by NULL —
-- the first disjunct grandfathers exactly them; every new insert path sets
-- requested_by.
ALTER TABLE suppliers ADD CONSTRAINT supplier_active_requires_approval CHECK (
  status <> 'active' OR requested_by IS NULL
  OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
);
ALTER TABLE suppliers ADD CONSTRAINT supplier_rejection_is_complete CHECK (
  (status <> 'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL))
  AND (status = 'rejected' OR (rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL))
);

-- One live row per supplier name: the insert paths do friendly read-then-409
-- duplicate checks, but only a partial unique index closes the concurrent
-- race — and duplicate rows would be PERMANENT (no-delete trigger below).
-- App code maps unique_violation on this index to the same 409.
CREATE UNIQUE INDEX suppliers_live_name_uq ON suppliers (lower(name))
  WHERE status IN ('pending_approval', 'active');

-- Suppliers now carry approval evidence — protect like other records (A.5.33).
CREATE TRIGGER suppliers_no_delete_tg
  BEFORE DELETE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER suppliers_no_truncate_tg
  BEFORE TRUNCATE ON suppliers
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- Supplier lifecycle guard (mirrors budget_version_state_machine, 0008):
-- suppliers are deliberately outside RLS (0006 — reference table), so these
-- rules are the DB-level backstop for the two-person control in production.
--   pending_approval → active/rejected (the deciding user writes the
--   matching evidence in the same statement); rejected is terminal;
--   active ↔ inactive (the sysadmin availability toggle, no evidence).
-- Identity and request/decision evidence are frozen outside the transition
-- that legitimately writes them.
CREATE FUNCTION suppliers_state_machine() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'a rejected supplier is immutable (A.5.33) — request it again as a new record'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (
    (OLD.status = 'pending_approval' AND NEW.status IN ('pending_approval', 'active', 'rejected'))
    OR (OLD.status = 'active'   AND NEW.status IN ('active', 'inactive'))
    OR (OLD.status = 'inactive' AND NEW.status IN ('inactive', 'active'))
  ) THEN
    RAISE EXCEPTION 'illegal supplier status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Identity + request evidence are written at insert and never change.
  IF NEW.name <> OLD.name
     OR coalesce(NEW.requested_by::text, '') <> coalesce(OLD.requested_by::text, '')
     OR coalesce(NEW.requested_at::text, '') <> coalesce(OLD.requested_at::text, '')
     OR coalesce(NEW.requested_reason, '') <> coalesce(OLD.requested_reason, '')
     OR coalesce(NEW.source_file_id::text, '') <> coalesce(OLD.source_file_id::text, '') THEN
    RAISE EXCEPTION 'supplier identity and request evidence are frozen (A.5.33)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Approval evidence is written exactly once, by the approving transition,
  -- and (when a user context exists) by the approving user themselves.
  IF coalesce(NEW.approved_by::text, '') <> coalesce(OLD.approved_by::text, '')
     OR coalesce(NEW.approved_at::text, '') <> coalesce(OLD.approved_at::text, '') THEN
    IF NOT (OLD.status = 'pending_approval' AND NEW.status = 'active') THEN
      RAISE EXCEPTION 'supplier approval evidence may only be written by the approving transition (A.5.33)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF app_current_user_id() IS NOT NULL AND NEW.approved_by IS DISTINCT FROM app_current_user_id() THEN
      RAISE EXCEPTION 'a supplier approval must be recorded by the approving user themselves (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF coalesce(NEW.rejected_by::text, '') <> coalesce(OLD.rejected_by::text, '')
     OR coalesce(NEW.rejected_at::text, '') <> coalesce(OLD.rejected_at::text, '')
     OR coalesce(NEW.rejection_reason, '') <> coalesce(OLD.rejection_reason, '') THEN
    IF NOT (OLD.status = 'pending_approval' AND NEW.status = 'rejected') THEN
      RAISE EXCEPTION 'supplier rejection evidence may only be written by the rejecting transition (A.5.33)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF app_current_user_id() IS NOT NULL AND NEW.rejected_by IS DISTINCT FROM app_current_user_id() THEN
      RAISE EXCEPTION 'a supplier rejection must be recorded by the rejecting user themselves (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER suppliers_state_machine_tg
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION suppliers_state_machine();

-- The supplier-import workbook is stored with no requisition, like DOA/budget
-- imports (0002 requisition_scope_matches_type must admit the new type).
ALTER TABLE attachments DROP CONSTRAINT requisition_scope_matches_type;
ALTER TABLE attachments ADD CONSTRAINT requisition_scope_matches_type CHECK (
  (type IN ('quote', 'invoice', 'other') AND requisition_id IS NOT NULL)
  OR (type IN ('doa_matrix', 'budget_import', 'supplier_import') AND requisition_id IS NULL)
);

-- The workbook is the evidence the supplier_approver acts on: the 0006 read
-- policy's requisition-less arm admitted only uploader/doa_admin/auditor, so
-- under the non-owner production role the approver could not read it
-- (adversarial-review finding). Supersedes the 0006 policy (0008 precedent).
DROP POLICY attachments_select ON attachments;
CREATE POLICY attachments_select ON attachments FOR SELECT
  USING (
    uploaded_by = app_current_user_id()
    OR (requisition_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM requisitions r
                    WHERE r.id = attachments.requisition_id
                      AND (r.requester_id = app_current_user_id()
                           OR app_user_can_read_cost_centre(r.cost_centre_id))))
    OR (requisition_id IS NULL
        AND (app_user_has_role('doa_admin') OR app_user_has_role('auditor')
             OR (type = 'supplier_import' AND app_user_has_role('supplier_approver'))))
  );

-- supplier_approver is an org-wide role (like budget_approver).
ALTER TABLE roles_assignments DROP CONSTRAINT org_wide_roles_have_no_cost_centre;
ALTER TABLE roles_assignments ADD CONSTRAINT org_wide_roles_have_no_cost_centre CHECK (
  role NOT IN ('sysadmin', 'auditor', 'accounting', 'doa_admin', 'budget_approver', 'doa_approver', 'supplier_approver')
  OR cost_centre_id IS NULL
);

-- ── SoD (A.5.3): sysadmin never holds supplier approval power; accounting is
-- never a requester (client rule: "they have no incentive to spend, thus
-- making their veto the most important — they should not be requesters").
CREATE OR REPLACE FUNCTION enforce_sod_on_role_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conflicting role_name;
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT ra.role INTO conflicting
  FROM roles_assignments ra
  WHERE ra.user_id = NEW.user_id
    AND ra.revoked_at IS NULL
    AND ra.id IS DISTINCT FROM NEW.id
    AND (
      (NEW.role = 'sysadmin' AND ra.role IN ('approver', 'budget_owner', 'accounting', 'doa_admin', 'budget_approver', 'doa_approver', 'supplier_approver'))
      OR (ra.role = 'sysadmin' AND NEW.role IN ('approver', 'budget_owner', 'accounting', 'doa_admin', 'budget_approver', 'doa_approver', 'supplier_approver'))
      OR (NEW.role = 'accounting' AND ra.role = 'approver')
      OR (ra.role = 'accounting' AND NEW.role = 'approver')
      -- Accounting holds the final financial veto — it must have no stake in
      -- the spend it reviews (client change list, Accounts role).
      OR (NEW.role = 'accounting' AND ra.role = 'requester')
      OR (ra.role = 'accounting' AND NEW.role = 'requester')
      -- ...and no hand in the DOA it reviews under: decide() 403s anyone who
      -- uploaded/activated the frozen version (doa_version_conflict), so an
      -- accounting holder with either DOA role would be assigned finance
      -- steps they are forbidden to decide (adversarial-review finding).
      OR (NEW.role = 'accounting' AND ra.role IN ('doa_admin', 'doa_approver'))
      OR (ra.role = 'accounting' AND NEW.role IN ('doa_admin', 'doa_approver'))
      OR (NEW.role = 'doa_admin' AND ra.role = 'approver')
      OR (ra.role = 'doa_admin' AND NEW.role = 'approver')
      OR (NEW.role = 'doa_admin' AND ra.role = 'doa_approver')
      OR (ra.role = 'doa_admin' AND NEW.role = 'doa_approver')
      -- section 3: nobody activates the DOA and approves against it
      OR (NEW.role = 'doa_approver' AND ra.role = 'approver')
      OR (ra.role = 'doa_approver' AND NEW.role = 'approver')
      OR (NEW.role = 'budget_approver' AND ra.role = 'budget_owner')
      OR (ra.role = 'budget_approver' AND NEW.role = 'budget_owner')
      OR (NEW.role = 'auditor' AND ra.role <> 'auditor')
      OR (ra.role = 'auditor' AND NEW.role <> 'auditor')
    )
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION 'segregation of duties (ISO 27001 A.5.3): role % conflicts with existing role % for this user',
      NEW.role, conflicting
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The trigger binds only FUTURE grants; a database migrated forward from a
-- pre-0014 state may already hold pairs the new rules forbid, silently
-- defeating the control they claim (adversarial-review finding). Fail loudly:
-- an operator revokes one grant per listed user through the admin flow (which
-- records revoked_by/reason and the audit entry) and re-runs the migration.
-- Auto-revoking here would be wrong twice over — a migration has no
-- legitimate actor to attribute the revocation to, and choosing WHICH role to
-- strip is a business decision. Only the pairs 0014 itself introduces are
-- checked; earlier pairs were bound by their own (now immutable) migrations.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT u.email, ', ' ORDER BY u.email) INTO offenders
  FROM roles_assignments a
  JOIN roles_assignments b ON b.user_id = a.user_id AND b.revoked_at IS NULL
  JOIN users u ON u.id = a.user_id
  WHERE a.revoked_at IS NULL
    AND a.role = 'accounting'
    AND b.role IN ('requester', 'doa_admin', 'doa_approver');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'segregation of duties (A.5.3): accounting may no longer be combined with requester/doa_admin/doa_approver. Revoke one grant (with reason, via the admin UI) for: ' || offenders,
      ERRCODE = 'check_violation';
  END IF;
END $$;

-- ── 4. Accounts final review step ────────────────────────────────────────────
ALTER TABLE approval_steps DROP CONSTRAINT approval_steps_purpose_check;
ALTER TABLE approval_steps ADD CONSTRAINT approval_steps_purpose_check CHECK (
  purpose IN ('doa', 'variance_reapproval', 'finance_review')
);

-- Approval now additionally requires every finance_review step to be approved.
-- (The DOA-steps-exist requirement stays: a chain is never finance-only.)
CREATE OR REPLACE FUNCTION requisitions_state_machine() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  undecided integer;
  denials   integer;
  self_decided integer;
BEGIN
  IF OLD.status IN ('denied', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'a % requisition is immutable (A.5.33)', OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (
    (OLD.status = 'draft'     AND NEW.status IN ('draft', 'submitted', 'cancelled'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('submitted', 'approved', 'denied', 'cancelled'))
    OR (OLD.status = 'approved'  AND NEW.status IN ('approved', 'closed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'illegal requisition status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Two-person supplier control (change 3): a requisition may only be
  -- submitted against a supplier the supplier_approver has vetted. Gate the
  -- submission transition, not the stored draft value — a requester may
  -- legitimately draft while their supplier request is still in flight.
  IF OLD.status = 'draft' AND NEW.status = 'submitted' AND NEW.supplier_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = NEW.supplier_id AND s.status = 'active') THEN
      RAISE EXCEPTION 'a requisition may only be submitted with an approved (active) supplier (A.5.19)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Frozen after leaving draft: the record the approvers judged (section 4 rule 1)
  IF OLD.status <> 'draft' THEN
    IF NEW.requester_id <> OLD.requester_id
       OR NEW.cost_centre_id <> OLD.cost_centre_id
       OR NEW.category_id <> OLD.category_id
       OR coalesce(NEW.supplier_id::text, '') <> coalesce(OLD.supplier_id::text, '')
       OR NEW.amount <> OLD.amount
       OR NEW.currency <> OLD.currency
       OR NEW.description <> OLD.description
       OR NEW.justification <> OLD.justification
       OR NEW.reference <> OLD.reference
       OR coalesce(NEW.needed_by::text, '') <> coalesce(OLD.needed_by::text, '')
       OR coalesce(NEW.doa_version_id::text, '') <> coalesce(OLD.doa_version_id::text, '')
       OR coalesce(NEW.doa_rule_snapshot::text, '') <> coalesce(OLD.doa_rule_snapshot::text, '')
       OR coalesce(NEW.submitted_at::text, '') <> coalesce(OLD.submitted_at::text, '') THEN
      RAISE EXCEPTION 'a submitted requisition is frozen except for status transitions (A.5.33)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- A.5.3: approval requires real, complete, non-self approver decisions —
  -- including the accounting finance_review step when one exists.
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    SELECT count(*) FILTER (WHERE s.decision <> 'approved'),
           count(*) FILTER (WHERE s.assigned_user_id = NEW.requester_id
                              AND s.delegate_of_user_id IS NULL)
      INTO undecided, self_decided
    FROM approval_steps s
    WHERE s.requisition_id = NEW.id AND s.purpose IN ('doa', 'finance_review');

    IF undecided IS NULL OR undecided > 0 THEN
      RAISE EXCEPTION 'a requisition cannot be approved while DOA or finance-review approval steps are undecided (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF self_decided > 0 THEN
      RAISE EXCEPTION 'a requisition cannot be approved by its own requester (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM approval_steps s
                   WHERE s.requisition_id = NEW.id AND s.purpose = 'doa') THEN
      RAISE EXCEPTION 'a requisition cannot be approved with no DOA approval steps (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF NEW.status = 'denied' AND OLD.status <> 'denied' THEN
    SELECT count(*) INTO denials
    FROM approval_steps s
    WHERE s.requisition_id = NEW.id AND s.decision = 'denied';
    IF denials = 0 THEN
      RAISE EXCEPTION 'a requisition cannot be denied without a recorded denial (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- finance_review steps are ROLE-addressed: any active accounting holder may
-- decide one (approvals.ts stamps the actual decider into assigned_user_id —
-- WITH CHECK keeps requiring exactly that). Accounting can never hold
-- 'approver' (SoD), so delegation can never cover an absence; without this
-- limb one person's leave would freeze every requisition at the final hurdle
-- (adversarial-review finding), and under the non-owner production role the
-- pickup would be silently impossible (RLS defence in depth).
DROP POLICY approval_steps_update ON approval_steps;
CREATE POLICY approval_steps_update ON approval_steps FOR UPDATE
  USING (assigned_user_id = app_current_user_id()
         OR (decision = 'pending' AND app_user_is_delegate_for(
               assigned_user_id,
               (SELECT r.cost_centre_id FROM requisitions r WHERE r.id = approval_steps.requisition_id)))
         OR (decision = 'pending' AND purpose = 'finance_review' AND app_user_has_role('accounting')))
  WITH CHECK (assigned_user_id = app_current_user_id());

-- Finalisation must actually persist under the non-owner production role
-- (adversarial-review finding, HIGH): decide() records the actor's decision
-- on their own step FIRST, so by the time it flips requisitions.status the
-- 0008 policy — which demanded a still-PENDING step assigned to the actor —
-- matched zero rows: approve/deny silently no-opped, and the audit log,
-- notifications and API response all recorded an approval that never
-- persisted. Dev/test connect as the table owner and bypass RLS, which is
-- why no test could see it. The requisitions_state_machine trigger remains
-- the sole authority on WHICH transitions are legal (approved requires every
-- doa+finance_review step approved; denied requires a recorded denial); this
-- policy only decides WHO may attempt one:
--   - the holder of a step on this requisition — still pending (their
--     decision flow), or already decided by them (the finalisation moment);
--   - a live delegate, while the delegator's step is pending;
--   - an org-wide accounting holder on an APPROVED requisition — the
--     approved → closed flip when the final invoice posts (accounting.ts),
--     which no approval step ever covers.
DROP POLICY requisitions_update_by_approver ON requisitions;
CREATE POLICY requisitions_update_by_approver ON requisitions FOR UPDATE
  USING (EXISTS (SELECT 1 FROM approval_steps s
                 WHERE s.requisition_id = requisitions.id
                   AND ((s.decision = 'pending'
                         AND (s.assigned_user_id = app_current_user_id()
                              OR app_user_is_delegate_for(s.assigned_user_id, requisitions.cost_centre_id)))
                        OR (s.decision <> 'pending' AND s.assigned_user_id = app_current_user_id())))
         OR (app_user_has_role('accounting') AND status = 'approved'))
  WITH CHECK (true); -- substance is frozen by requisitions_state_machine (trigger), not by this policy

-- The startup migration-currency guard (index.ts) reads the ledger as the
-- app role; migrate.ts creates schema_migrations before applying any file,
-- so this grant is valid on the very first run.
GRANT SELECT ON schema_migrations TO massy_app;

-- Whether submission appends the accounting finance_review step (client rule:
-- "the head of accounts... has to be the final hurdle for approvals").
INSERT INTO app_settings (key, value, description) VALUES
  ('accounting_final_approval', 'true',
   'When true, every requisition approval chain ends with a finance_review step assigned to the org-wide accounting role (the "Accounts final hurdle"). Boolean.')
ON CONFLICT (key) DO NOTHING;

-- Domains the sysadmin may pre-provision users under. A pre-provisioned row
-- is claimed at first sign-in by case-insensitive email match, so a typo'd
-- or external domain would hand the pre-granted roles to whichever tenant
-- identity carries that address (adversarial-review finding). Empty array =
-- any domain (the pilot's posture until the client confirms theirs).
INSERT INTO app_settings (key, value, description) VALUES
  ('allowed_email_domains', '[]',
   'Email domains permitted for pre-provisioned users (JSON array of lowercase domains, e.g. ["massymotors.com"]). Empty array = any domain. Guards the email-match claim of pre-provisioned accounts.')
ON CONFLICT (key) DO NOTHING;

-- ── Reassignment of orphaned steps learns the new descriptor + step purpose ──
-- Adds: 'tier' descriptors (match on the approver grant's tier) and
-- 'finance_review' steps (re-resolve to the earliest active accounting holder).
CREATE OR REPLACE FUNCTION app_reassign_orphaned_steps(p_affected uuid, p_cost_centre uuid)
RETURNS TABLE (
  step_id           uuid,
  requisition_id    uuid,
  reference         text,
  step_purpose      text,
  new_assignee      uuid,
  new_assignee_name text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  st RECORD;
  v_descriptor jsonb;
  v_type text;
  v_value text;
  v_new uuid;
  v_new_name text;
BEGIN
  IF NOT app_user_has_role('sysadmin') THEN
    RAISE EXCEPTION 'only a sysadmin may reassign approval steps (A.5.18)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR st IN
    SELECT s.id AS s_id, s.step_no, s.purpose,
           r.id AS r_id, r.reference AS r_reference, r.requester_id, r.cost_centre_id,
           r.doa_version_id, r.doa_rule_snapshot
    FROM approval_steps s
    JOIN requisitions r ON r.id = s.requisition_id
    WHERE s.assigned_user_id = p_affected
      AND s.decision = 'pending'
      AND ((s.purpose IN ('doa', 'finance_review') AND r.status = 'submitted')
           OR (s.purpose = 'variance_reapproval' AND r.status IN ('approved', 'closed')))
      AND (p_cost_centre IS NULL OR r.cost_centre_id = p_cost_centre)
    ORDER BY r.reference, s.step_no
  LOOP
    v_new := NULL;
    v_new_name := NULL;

    IF st.purpose = 'finance_review' THEN
      -- The Accounts step belongs to the org-wide accounting role, not to a
      -- DOA descriptor: earliest active accounting holder who is neither the
      -- departing user, the requester, a party to the frozen DOA version
      -- (decide() 403s uploader/activator on doa_version_conflict), nor
      -- already on the chain.
      SELECT u.id, u.display_name INTO v_new, v_new_name
      FROM users u
      JOIN roles_assignments ra ON ra.user_id = u.id
        AND ra.role = 'accounting' AND ra.revoked_at IS NULL
      WHERE u.status = 'active'
        AND u.id <> p_affected
        AND u.id <> st.requester_id
        AND NOT EXISTS (SELECT 1 FROM doa_matrix_versions dv
                        WHERE dv.id = st.doa_version_id
                          AND u.id IN (dv.uploaded_by, dv.approved_by))
        AND NOT EXISTS (SELECT 1 FROM approval_steps o
                        WHERE o.requisition_id = st.r_id AND o.id <> st.s_id
                          AND o.assigned_user_id = u.id)
      GROUP BY u.id, u.display_name
      ORDER BY min(ra.granted_at), u.id
      LIMIT 1;
    ELSE
      -- The descriptor this step was resolved from; a variance re-approval
      -- belongs to the FINAL approver level (plan §5.4).
      IF st.purpose = 'doa' THEN
        SELECT rs->'descriptor' INTO v_descriptor
        FROM jsonb_array_elements(st.doa_rule_snapshot->'resolvedSteps') rs
        WHERE (rs->>'stepNo')::int = st.step_no;
      ELSE
        SELECT rs->'descriptor' INTO v_descriptor
        FROM jsonb_array_elements(st.doa_rule_snapshot->'resolvedSteps') rs
        ORDER BY (rs->>'stepNo')::int DESC LIMIT 1;
      END IF;

      IF v_descriptor IS NOT NULL THEN
        v_type := v_descriptor->>'type';
        v_value := v_descriptor->>'value';
        SELECT u.id, u.display_name INTO v_new, v_new_name
        FROM users u
        JOIN roles_assignments ra ON ra.user_id = u.id
          AND ra.role = 'approver' AND ra.revoked_at IS NULL
          AND (ra.cost_centre_id = st.cost_centre_id OR ra.cost_centre_id IS NULL)
          AND (v_type <> 'tier' OR ra.tier::text = v_value)
        WHERE u.status = 'active'
          AND u.id <> p_affected
          AND u.id <> st.requester_id           -- A.5.3: never the requester
          AND (v_type IN ('role', 'tier')
               OR (v_type = 'job_title' AND lower(u.job_title) = lower(v_value))
               OR (v_type = 'user' AND lower(u.email) = lower(v_value)))
          -- A person appearing twice in a chain approves once (§2.17): never
          -- give someone a second step on the same requisition.
          AND NOT EXISTS (SELECT 1 FROM approval_steps o
                          WHERE o.requisition_id = st.r_id AND o.id <> st.s_id
                            AND o.assigned_user_id = u.id)
        GROUP BY u.id, u.display_name
        ORDER BY min(ra.granted_at), u.id
        LIMIT 1;
      END IF;
    END IF;

    IF v_new IS NOT NULL THEN
      UPDATE approval_steps s SET assigned_user_id = v_new
      WHERE s.id = st.s_id AND s.decision = 'pending';
    END IF;

    step_id := st.s_id;
    requisition_id := st.r_id;
    reference := st.r_reference;
    step_purpose := st.purpose;
    new_assignee := v_new;
    new_assignee_name := v_new_name;
    RETURN NEXT;
  END LOOP;
END;
$$;
