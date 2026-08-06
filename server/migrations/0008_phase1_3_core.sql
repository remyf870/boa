-- 0008: Phases 1-3 schema — configurable settings, delegation, budget
-- governance (plan section 5.9), SLA columns, saved filters, notification
-- outbox, requisition state-machine protection, scanner RLS, SoD updates.
-- Everything configurable is data in the database, never a code constant
-- (plan section 0.3).

-- ── app_settings — configurable values live in the DB (plan section 0.3) ─────
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text NOT NULL,
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value, description) VALUES
  ('base_currency', '"TTD"',
   'Single base currency (ASSUMPTIONS section 2.1, TODO(client) plan section 9 Q2). All amounts are validated against this.'),
  ('sla_reminder_days', '3',
   'Plan section 5.2: days a step may sit pending before the approver is reminded. TODO(client).'),
  ('sla_escalation_days', '5',
   'Plan section 5.2: days pending before the escalation flag + notification. Escalation notifies, never auto-approves. TODO(client).'),
  ('invoice_variance_tolerance', '0.05',
   'Plan section 5.4: invoice variance vs approved amount beyond this fraction requires re-approval by the final approver. TODO(client).'),
  ('fiscal_year_start_month', '1',
   'Month (1-12) the fiscal year starts. 1 = calendar year. Drives which period a purchase commits against (ASSUMPTIONS section 2.2a). TODO(client).'),
  ('attachment_max_bytes', '15728640',
   'A.8.7 size cap for uploads (15 MiB default). TODO(client).'),
  ('budget_required_approvals', '1',
   'Plan section 5.9 / section 9 Q13: approvals needed to activate a budget version. Interim: one budget_approver who is not the proposer. TODO(client).');

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_settings_select ON app_settings FOR SELECT
  USING (app_current_user_id() IS NOT NULL);
-- Section 3: config belongs to the System Admin (who still cannot approve or
-- touch financial records).
CREATE POLICY app_settings_write ON app_settings FOR UPDATE
  USING (app_user_has_role('sysadmin'))
  WITH CHECK (app_user_has_role('sysadmin'));
CREATE POLICY app_settings_insert ON app_settings FOR INSERT
  WITH CHECK (app_user_has_role('sysadmin'));

-- Which fiscal period (e.g. FY2026-Q3) a timestamp falls in, per the
-- configurable fiscal year start. Quarterly per ASSUMPTIONS section 2.2.
-- FY label = calendar year when the FY starts in January, else the calendar
-- year the FY ENDS in (e.g. start=10: Oct 2025 - Sep 2026 = FY2026).
CREATE FUNCTION fiscal_period_of(ts timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH cfg AS (
    SELECT coalesce((SELECT (value #>> '{}')::int FROM app_settings WHERE key = 'fiscal_year_start_month'), 1) AS start_month
  ), parts AS (
    SELECT extract(year FROM ts AT TIME ZONE 'UTC')::int AS y,
           extract(month FROM ts AT TIME ZONE 'UTC')::int AS m,
           start_month
    FROM cfg
  )
  SELECT 'FY'
    || (CASE WHEN start_month = 1 THEN y
             WHEN m >= start_month THEN y + 1
             ELSE y END)::text
    || '-Q'
    || (((m - start_month + 12) % 12) / 3 + 1)::text
  FROM parts;
$$;

-- ── Delegation (plan section 5.2) ────────────────────────────────────────────
-- An approver nominates a delegate for a date range. The delegate's decision
-- records both identities on the approval step. Records of authority are never
-- deleted; revocation is a timestamp (A.5.33 posture).
CREATE TABLE delegations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator_id    uuid NOT NULL REFERENCES users (id),
  delegate_id     uuid NOT NULL REFERENCES users (id),
  cost_centre_id  uuid REFERENCES cost_centres (id), -- NULL = all the delegator's cost centres
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users (id),
  CONSTRAINT delegate_is_not_delegator CHECK (delegate_id <> delegator_id),
  CONSTRAINT delegation_range_ordered CHECK (ends_at > starts_at)
);
CREATE INDEX delegations_delegate_live_ix ON delegations (delegate_id) WHERE revoked_at IS NULL;
CREATE INDEX delegations_delegator_live_ix ON delegations (delegator_id) WHERE revoked_at IS NULL;

CREATE TRIGGER delegations_no_delete_tg
  BEFORE DELETE ON delegations FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER delegations_no_truncate_tg
  BEFORE TRUNCATE ON delegations FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- Is the acting user a live delegate for p_delegator (optionally scoped)?
-- Delegation redirects work — it never mints authority (A.5.15): the delegate
-- must additionally hold the approver role for the cost centre themselves.
CREATE FUNCTION app_user_is_delegate_for(p_delegator uuid, p_cost_centre uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM delegations d
    WHERE d.delegator_id = p_delegator
      AND d.delegate_id = app_current_user_id()
      AND d.revoked_at IS NULL
      AND now() >= d.starts_at AND now() < d.ends_at
      AND (d.cost_centre_id IS NULL OR d.cost_centre_id = p_cost_centre)
  ) AND app_user_has_role('approver', p_cost_centre);
$$;

ALTER TABLE delegations ENABLE ROW LEVEL SECURITY;
CREATE POLICY delegations_select ON delegations FOR SELECT
  USING (delegator_id = app_current_user_id()
         OR delegate_id = app_current_user_id()
         OR app_user_has_role('sysadmin')
         OR app_user_has_role('auditor'));
CREATE POLICY delegations_insert ON delegations FOR INSERT
  WITH CHECK (delegator_id = app_current_user_id());
CREATE POLICY delegations_update ON delegations FOR UPDATE
  USING (delegator_id = app_current_user_id() OR app_user_has_role('sysadmin'))
  WITH CHECK (delegator_id = app_current_user_id() OR app_user_has_role('sysadmin'));

-- ── Approval steps: SLA tracking + purpose (plan sections 5.2, 5.4) ─────────
ALTER TABLE approval_steps
  ADD COLUMN reminder_sent_at timestamptz,
  ADD COLUMN escalated_at     timestamptz,
  ADD COLUMN purpose          text NOT NULL DEFAULT 'doa'
    CHECK (purpose IN ('doa', 'variance_reapproval'));

-- Delegates must see and decide steps assigned to their delegator (both
-- policies were assigned-user-only in 0006).
DROP POLICY approval_steps_select ON approval_steps;
CREATE POLICY approval_steps_select ON approval_steps FOR SELECT
  USING (assigned_user_id = app_current_user_id()
         OR delegate_of_user_id = app_current_user_id()
         OR (decision = 'pending' AND app_user_is_delegate_for(
               assigned_user_id,
               (SELECT r.cost_centre_id FROM requisitions r WHERE r.id = approval_steps.requisition_id)))
         OR EXISTS (SELECT 1 FROM requisitions r
                    WHERE r.id = approval_steps.requisition_id
                      AND (r.requester_id = app_current_user_id()
                           OR app_user_can_read_cost_centre(r.cost_centre_id))));
DROP POLICY approval_steps_update ON approval_steps;
-- On a delegated decision the app re-points assigned_user_id to the delegate
-- and records the delegator in delegate_of_user_id (both identities, plan
-- section 5.2) — hence WITH CHECK on the NEW row's assignee.
CREATE POLICY approval_steps_update ON approval_steps FOR UPDATE
  USING (assigned_user_id = app_current_user_id()
         OR (decision = 'pending' AND app_user_is_delegate_for(
               assigned_user_id,
               (SELECT r.cost_centre_id FROM requisitions r WHERE r.id = approval_steps.requisition_id))))
  WITH CHECK (assigned_user_id = app_current_user_id());

-- ── Requisitions: routing flags, approval timestamp, state machine ───────────
ALTER TABLE requisitions
  ADD COLUMN workflow_flags jsonb NOT NULL DEFAULT '[]'::jsonb, -- e.g. self-approval skips (A.5.3 "flags it")
  ADD COLUMN approved_at   timestamptz;                        -- final approval moment; drives the commitment period

ALTER TABLE requisitions
  ADD CONSTRAINT approved_state_is_complete CHECK (
    status NOT IN ('approved', 'closed')
    OR (approved_at IS NOT NULL AND approval_reference IS NOT NULL)
  );

-- A.5.33: after submission the financial substance of a requisition is frozen;
-- only legal status transitions (and their bookkeeping columns) may occur.
CREATE FUNCTION requisitions_state_machine() RETURNS trigger
LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER requisitions_state_machine_tg
  BEFORE UPDATE ON requisitions
  FOR EACH ROW EXECUTE FUNCTION requisitions_state_machine();

-- The assigned approver (or their live delegate) must be able to move the
-- requisition through decision transitions; 0006 allowed only the requester.
CREATE POLICY requisitions_update_by_approver ON requisitions FOR UPDATE
  USING (EXISTS (SELECT 1 FROM approval_steps s
                 WHERE s.requisition_id = requisitions.id
                   AND s.decision = 'pending'
                   AND (s.assigned_user_id = app_current_user_id()
                        OR app_user_is_delegate_for(s.assigned_user_id, requisitions.cost_centre_id))))
  WITH CHECK (true); -- substance is frozen by requisitions_state_machine (trigger), not by this policy

-- ── Budget governance (plan section 5.9) ─────────────────────────────────────
CREATE TYPE budget_version_status AS ENUM
  ('draft', 'pending_approval', 'active', 'rejected', 'superseded');

CREATE TABLE budget_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_centre_id    uuid NOT NULL REFERENCES cost_centres (id),
  period            text NOT NULL CHECK (period ~ '^FY[0-9]{4}(-Q[1-4])?$'),
  version_no        integer NOT NULL,
  status            budget_version_status NOT NULL DEFAULT 'draft',
  reason            text NOT NULL, -- why this budget / this change — mandatory
  source_file_id    uuid REFERENCES attachments (id),
  file_sha256       char(64),
  proposed_by       uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at      timestamptz,
  approved_by       uuid REFERENCES users (id),
  approved_at       timestamptz,
  rejected_by       uuid REFERENCES users (id),
  rejected_at       timestamptz,
  rejection_reason  text,
  superseded_at     timestamptz,
  UNIQUE (cost_centre_id, period, version_no),
  -- Two-person rule (plan sections 3, 5.9): the proposer can never activate
  CONSTRAINT budget_two_person_rule CHECK (approved_by IS NULL OR approved_by <> proposed_by),
  CONSTRAINT budget_active_requires_approval CHECK (
    status NOT IN ('active', 'superseded') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT budget_rejection_is_complete CHECK (
    status <> 'rejected'
    OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)
  )
);
-- Exactly one active version per cost centre × period
CREATE UNIQUE INDEX budget_versions_one_active_uq
  ON budget_versions (cost_centre_id, period) WHERE status = 'active';

CREATE TRIGGER budget_versions_no_delete_tg
  BEFORE DELETE ON budget_versions FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER budget_versions_no_truncate_tg
  BEFORE TRUNCATE ON budget_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- Budget version state machine: versions only ever move forward, and the
-- decision belongs to the acting user (defence-in-depth behind the API).
CREATE FUNCTION budget_version_state_machine() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('rejected', 'superseded') THEN
    RAISE EXCEPTION 'a % budget version is immutable (A.5.33)', OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status = 'active' THEN
    IF NEW.status <> 'superseded'
       OR NEW.version_no <> OLD.version_no
       OR NEW.cost_centre_id <> OLD.cost_centre_id
       OR NEW.period <> OLD.period
       OR NEW.proposed_by <> OLD.proposed_by
       OR coalesce(NEW.approved_by::text, '') <> coalesce(OLD.approved_by::text, '')
       OR coalesce(NEW.approved_at::text, '') <> coalesce(OLD.approved_at::text, '') THEN
      RAISE EXCEPTION 'an active budget version can only be superseded, never edited (A.5.33)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.superseded_at := coalesce(NEW.superseded_at, now());
  ELSIF OLD.status = 'pending_approval' THEN
    IF NEW.status NOT IN ('pending_approval', 'active', 'rejected', 'draft') THEN
      RAISE EXCEPTION 'illegal budget version transition pending_approval -> %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    -- The recorded decider must be the acting user (when an app context exists)
    IF NEW.status = 'active' AND app_current_user_id() IS NOT NULL
       AND NEW.approved_by IS DISTINCT FROM app_current_user_id() THEN
      RAISE EXCEPTION 'approved_by must be the acting user (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'rejected' AND app_current_user_id() IS NOT NULL
       AND NEW.rejected_by IS DISTINCT FROM app_current_user_id() THEN
      RAISE EXCEPTION 'rejected_by must be the acting user (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'pending_approval') THEN
      RAISE EXCEPTION 'a draft budget version must be submitted for approval before it can activate (plan section 5.9)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_version_state_machine_tg
  BEFORE UPDATE ON budget_versions
  FOR EACH ROW EXECUTE FUNCTION budget_version_state_machine();

-- Budget lines (the existing `budgets` table) now belong to a version.
-- Legacy rows without a version (pre-0008 dev seeds) never count toward the
-- live position — the position query joins through active budget_versions.
ALTER TABLE budgets ADD COLUMN version_id uuid REFERENCES budget_versions (id);
CREATE INDEX budgets_version_ix ON budgets (version_id);

-- Lines are editable only while their version is draft; new lines require a
-- version; lines can never be re-pointed to another version.
CREATE FUNCTION budget_lines_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status budget_version_status;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version_id IS NULL THEN
      RAISE EXCEPTION 'budget lines must belong to a budget version (plan section 5.9)'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT status INTO v_status FROM budget_versions WHERE id = NEW.version_id;
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines of a % budget version are immutable (A.5.33)', v_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF OLD.version_id IS NULL THEN
      RAISE EXCEPTION 'legacy budget rows without a version are frozen — propose a budget version instead (plan section 5.9)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.version_id IS DISTINCT FROM OLD.version_id THEN
      RAISE EXCEPTION 'budget lines can never move between versions (A.5.33)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT status INTO v_status FROM budget_versions WHERE id = OLD.version_id;
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines of a % budget version are immutable (A.5.33)', v_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_lines_frozen_tg
  BEFORE INSERT OR UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION budget_lines_frozen();

-- RLS: proposals are written by the budget owner; read visibility extends to
-- everyone who sees the live position — including requesters, who the plan
-- (section 5.1) shows "available budget" as they type.
DROP POLICY budgets_select ON budgets;
CREATE POLICY budgets_select ON budgets FOR SELECT
  USING (app_user_can_read_cost_centre(cost_centre_id)
         OR app_user_has_role('budget_owner', cost_centre_id)
         OR app_user_has_role('approver', cost_centre_id)
         OR app_user_has_role('requester', cost_centre_id)   -- section 5.1 live budget display
         OR app_user_has_role('budget_approver'));           -- reviews proposals org-wide
DROP POLICY budgets_insert ON budgets;
CREATE POLICY budgets_insert ON budgets FOR INSERT
  WITH CHECK (app_user_has_role('budget_owner', cost_centre_id));
DROP POLICY budgets_update ON budgets;
CREATE POLICY budgets_update ON budgets FOR UPDATE
  USING (app_user_has_role('budget_owner', cost_centre_id))
  WITH CHECK (app_user_has_role('budget_owner', cost_centre_id));

ALTER TABLE budget_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_versions_select ON budget_versions FOR SELECT
  USING (app_user_can_read_cost_centre(cost_centre_id)
         OR app_user_has_role('budget_owner', cost_centre_id)
         OR app_user_has_role('approver', cost_centre_id)
         OR app_user_has_role('requester', cost_centre_id)
         OR app_user_has_role('budget_approver'));
CREATE POLICY budget_versions_insert ON budget_versions FOR INSERT
  WITH CHECK (proposed_by = app_current_user_id()
              AND app_user_has_role('budget_owner', cost_centre_id));
CREATE POLICY budget_versions_update ON budget_versions FOR UPDATE
  USING (
    (proposed_by = app_current_user_id() AND status IN ('draft', 'pending_approval'))
    OR (app_user_has_role('budget_approver') AND status IN ('pending_approval', 'active'))
  )
  WITH CHECK (
    (proposed_by = app_current_user_id() AND status IN ('draft', 'pending_approval'))
    OR (app_user_has_role('budget_approver') AND status IN ('active', 'rejected', 'superseded'))
  );

-- ── DOA activation by the doa_approver role (plan section 6.1 two-person rule) ─
-- 0006 allowed only doa_admin to update DOA versions; the activating second
-- person holds doa_approver (mapped to the Finance Director). The two_person
-- CHECK (0002) plus the decision-integrity rule below keep either role from
-- collapsing the rule.
DROP POLICY doa_versions_update ON doa_matrix_versions;
CREATE POLICY doa_versions_update ON doa_matrix_versions FOR UPDATE
  USING (app_user_has_role('doa_admin') OR app_user_has_role('doa_approver'))
  WITH CHECK (app_user_has_role('doa_admin') OR app_user_has_role('doa_approver'));

-- Extend the DOA immutability trigger: activation must record the acting user
-- as approver, and a draft can only become active or stay draft.
CREATE OR REPLACE FUNCTION doa_version_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'superseded DOA versions are immutable (A.5.33)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'active' THEN
    IF NEW.status <> 'superseded'
       OR NEW.version_no <> OLD.version_no
       OR NEW.uploaded_by <> OLD.uploaded_by
       OR coalesce(NEW.file_sha256, '') <> coalesce(OLD.file_sha256, '')
       OR coalesce(NEW.approved_by::text, '') <> coalesce(OLD.approved_by::text, '') THEN
      RAISE EXCEPTION 'an active DOA version can only be superseded, never edited (A.5.33)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'active') THEN
      RAISE EXCEPTION 'illegal DOA version transition draft -> %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'active' AND app_current_user_id() IS NOT NULL
       AND NEW.approved_by IS DISTINCT FROM app_current_user_id() THEN
      RAISE EXCEPTION 'the DOA activation approver must be the acting user (A.5.3)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── Invoices: who submitted, and the variance re-approval link ───────────────
ALTER TABLE invoices
  ADD COLUMN submitted_by       uuid REFERENCES users (id),
  ADD COLUMN reapproval_step_id uuid REFERENCES approval_steps (id);

-- The final approver decides a variance re-approval on the invoice itself;
-- accounting posts. 0006 allowed accounting only.
DROP POLICY invoices_update ON invoices;
CREATE POLICY invoices_update ON invoices FOR UPDATE
  USING (app_user_has_role('accounting')
         OR EXISTS (SELECT 1 FROM approval_steps s
                    WHERE s.id = invoices.reapproval_step_id
                      AND s.assigned_user_id = app_current_user_id()))
  WITH CHECK (app_user_has_role('accounting')
              OR EXISTS (SELECT 1 FROM approval_steps s
                         WHERE s.id = invoices.reapproval_step_id
                           AND s.assigned_user_id = app_current_user_id()));

-- ── Attachment scanner service context (A.8.7) ───────────────────────────────
-- The scanner pipeline is the only writer of scan_status; it runs under a
-- dedicated service context, not a user context. The evidence-freeze trigger
-- (0004) already confines what any UPDATE may change.
CREATE POLICY attachments_update_scan ON attachments FOR UPDATE
  USING (current_setting('app.service', true) = 'scanner')
  WITH CHECK (current_setting('app.service', true) = 'scanner');

-- ── Saved filters (plan section 5.6) — personal, deletable convenience data ──
CREATE TABLE saved_filters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  view        text NOT NULL,
  name        text NOT NULL,
  filter      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, view, name)
);
ALTER TABLE saved_filters ENABLE ROW LEVEL SECURITY;
CREATE POLICY saved_filters_all ON saved_filters
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- ── Notification outbox (plan section 5.2 / A.5.14) ──────────────────────────
-- Rows deliberately carry NO financial data: a template id, a deep link and a
-- requisition/budget reference only. The mailer job reads and sends; failures
-- stay visible here. No RLS: operational table, nothing sensitive by design
-- (enforced by test), and the mailer runs without a user context.
CREATE TABLE notification_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id  uuid NOT NULL REFERENCES users (id),
  template           text NOT NULL,
  subject            text NOT NULL,
  deep_link          text NOT NULL,
  context            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text
);
CREATE INDEX notification_outbox_unsent_ix ON notification_outbox (created_at) WHERE sent_at IS NULL;

-- ── Role model updates for the new org-wide roles ────────────────────────────
ALTER TABLE roles_assignments DROP CONSTRAINT org_wide_roles_have_no_cost_centre;
ALTER TABLE roles_assignments ADD CONSTRAINT org_wide_roles_have_no_cost_centre CHECK (
  role NOT IN ('sysadmin', 'auditor', 'accounting', 'doa_admin', 'budget_approver', 'doa_approver')
  OR cost_centre_id IS NULL
);

-- SoD (A.5.3) extended: sysadmin still cannot hold any financial/approval
-- role; the budget approver can never also propose budgets (plan section 3);
-- the DOA uploader role can never also hold the DOA activation role.
CREATE OR REPLACE FUNCTION enforce_sod_on_role_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conflicting role_name;
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW; -- revocations never create a conflict
  END IF;

  SELECT ra.role INTO conflicting
  FROM roles_assignments ra
  WHERE ra.user_id = NEW.user_id
    AND ra.revoked_at IS NULL
    AND ra.id IS DISTINCT FROM NEW.id
    AND (
      -- System Admin cannot approve, edit budgets, post invoices or govern the DOA/budget (section 3)
      (NEW.role = 'sysadmin' AND ra.role IN ('approver', 'budget_owner', 'accounting', 'doa_admin', 'budget_approver', 'doa_approver'))
      OR (ra.role = 'sysadmin' AND NEW.role IN ('approver', 'budget_owner', 'accounting', 'doa_admin', 'budget_approver', 'doa_approver'))
      -- Accounting cannot approve (section 3)
      OR (NEW.role = 'accounting' AND ra.role = 'approver')
      OR (ra.role = 'accounting' AND NEW.role = 'approver')
      -- The DOA administrator cannot approve requisitions (section 3)
      OR (NEW.role = 'doa_admin' AND ra.role = 'approver')
      OR (ra.role = 'doa_admin' AND NEW.role = 'approver')
      -- The DOA uploader can never also be the DOA activator (section 6.1 two-person rule)
      OR (NEW.role = 'doa_admin' AND ra.role = 'doa_approver')
      OR (ra.role = 'doa_admin' AND NEW.role = 'doa_approver')
      -- The budget approver can never also propose budgets (sections 3, 5.9)
      OR (NEW.role = 'budget_approver' AND ra.role = 'budget_owner')
      OR (ra.role = 'budget_approver' AND NEW.role = 'budget_owner')
      -- Auditor is read-only across everything (section 3)
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

-- ── Grants (least privilege, extends 0005) ───────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON
  app_settings,
  delegations,
  budget_versions,
  notification_outbox
TO massy_app;
-- Saved filters are personal convenience data, not records — deletable.
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_filters TO massy_app;
