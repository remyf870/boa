-- 0010: fixes for the Phase 1-3 adversarial security review (2026-08-05).
-- Every change here closes a defect that was confirmed by reading the code and
-- walking a concrete failure path. Grouped by the control it protects.

-- ── A.8.3 / plan section 0.3: app_settings must be readable by the service ──
-- Defect: readSetting() runs on the bare pool (no app.user_id) in several
-- routes and in the SLA job. Under the mandated non-owner role, the
-- "authenticated user" policy returned zero rows, so requisition creation,
-- uploads and the SLA job would fail in production while passing in tests
-- (tests connect as the table owner and bypass RLS).
-- Settings are non-sensitive operational configuration; the sensitive part is
-- WRITING them, which stays sysadmin-only. Reads are therefore open to the
-- application role, and no code path depends on a user context to read config.
DROP POLICY app_settings_select ON app_settings;
CREATE POLICY app_settings_select ON app_settings FOR SELECT USING (true);

-- Same class of defect: the DOA template export and the "who will approve
-- this" preview read doa_rules/doa_matrix_versions. Those are already
-- readable by any authenticated user; make them readable without a user
-- context too, so a service-context read (exports, jobs) cannot silently
-- return an empty matrix. Rule CONTENT is not confidential — it is the
-- published approval policy; writes remain doa_admin-only.
DROP POLICY doa_versions_select ON doa_matrix_versions;
CREATE POLICY doa_versions_select ON doa_matrix_versions FOR SELECT USING (true);
DROP POLICY doa_rules_select ON doa_rules;
CREATE POLICY doa_rules_select ON doa_rules FOR SELECT USING (true);

-- ── A.5.3 / A.8.3: RLS must not let a requester self-approve ─────────────────
-- Defect: requisitions_update (0006) let the requester UPDATE their own row,
-- and the state machine allowed submitted -> approved for ANY updater, so a
-- compromised code path could mint an approval reference with no approver.
-- Fix: the requester's own-row UPDATE policy is restricted to rows that are
-- still drafts (edit/submit); approval transitions are reachable only through
-- the approver policy (requisitions_update_by_approver), and the state machine
-- below additionally proves the decision is real.
DROP POLICY requisitions_update ON requisitions;
CREATE POLICY requisitions_update ON requisitions FOR UPDATE
  USING (requester_id = app_current_user_id()
         AND status IN ('draft', 'submitted', 'approved'))
  WITH CHECK (requester_id = app_current_user_id()
              AND app_user_has_role('requester', cost_centre_id));

-- Defect: approval_steps_insert let a requester insert steps on their own
-- requisition with ANY decision value — including a pre-approved step naming
-- themselves. Steps may now only be created pending and undecided.
DROP POLICY approval_steps_insert ON approval_steps;
CREATE POLICY approval_steps_insert ON approval_steps FOR INSERT
  WITH CHECK (
    decision = 'pending'
    AND decided_at IS NULL
    AND decision_reason IS NULL
    AND EXISTS (SELECT 1 FROM requisitions r
                WHERE r.id = approval_steps.requisition_id
                  AND r.requester_id = app_current_user_id())
  );

-- The decisive database-layer guarantee (A.5.3): a requisition can only become
-- 'approved' when every DOA step actually carries an 'approved' decision, and
-- can only become 'denied' when a step actually carries a 'denied' decision.
-- No application bug, injection, or direct SQL can mint an approval reference
-- without real approver decisions on record.
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

  -- A.5.3: approval requires real, complete, non-self approver decisions
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    SELECT count(*) FILTER (WHERE s.decision <> 'approved'),
           count(*) FILTER (WHERE s.assigned_user_id = NEW.requester_id
                              AND s.delegate_of_user_id IS NULL)
      INTO undecided, self_decided
    FROM approval_steps s
    WHERE s.requisition_id = NEW.id AND s.purpose = 'doa';

    IF undecided IS NULL OR undecided > 0 THEN
      RAISE EXCEPTION 'a requisition cannot be approved while DOA approval steps are undecided (A.5.3)'
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

-- ── plan section 5.4 / section 4 rule 2: invoices may never exceed the approval ─
-- Defect: variance was computed per invoice against the full approved amount,
-- so N invoices each within tolerance could post N x the approved spend, and
-- posting was gated only on invoice status (a cancelled requisition's invoice
-- was still postable). This trigger is the backstop; the routes carry the
-- friendly errors.
CREATE FUNCTION invoices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req            requisitions%ROWTYPE;
  other_relevant numeric(14,2);
  tolerance      numeric;
BEGIN
  SELECT * INTO req FROM requisitions WHERE id = NEW.requisition_id;

  -- Spend may only be recorded against a live approval (plan section 5.4).
  -- OLD is only bound on UPDATE, so every OLD reference is inside TG_OP guards.
  IF TG_OP = 'INSERT' THEN
    IF req.status <> 'approved' THEN
      RAISE EXCEPTION 'an invoice can only be submitted against an approved requisition (plan section 5.4)'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'posted' AND OLD.status <> 'posted'
        AND req.status NOT IN ('approved', 'closed') THEN
    RAISE EXCEPTION 'an invoice cannot be posted against a % requisition (plan section 5.4)', req.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Plan section 5.4, enforced CUMULATIVELY: when the running total of live
  -- invoices exceeds the approved amount plus tolerance, that invoice may only
  -- be submitted-for-posting or posted if a variance re-approval was actually
  -- GRANTED for it. Comparing each invoice to the approved amount in isolation
  -- let N invoices, each individually within tolerance, post N times the
  -- approved spend (adversarial-review finding).
  -- 'pending_reapproval' is deliberately exempt: that IS the state in which the
  -- over-tolerance invoice waits for the approver's decision.
  IF NEW.status IN ('submitted', 'posted') THEN
    SELECT coalesce(sum(i.amount), 0) INTO other_relevant
    FROM invoices i
    WHERE i.requisition_id = NEW.requisition_id
      AND i.id <> NEW.id
      AND i.status <> 'rejected';
    SELECT coalesce((SELECT (value #>> '{}')::numeric FROM app_settings WHERE key = 'invoice_variance_tolerance'), 0)
      INTO tolerance;
    IF other_relevant + NEW.amount > req.amount * (1 + tolerance)
       AND NOT EXISTS (
         SELECT 1 FROM approval_steps s
         WHERE s.id = NEW.reapproval_step_id
           AND s.purpose = 'variance_reapproval'
           AND s.decision = 'approved'
       ) THEN
      RAISE EXCEPTION
        'invoices totalling % exceed the approved amount % plus the % tolerance with no granted variance re-approval (plan section 5.4)',
        other_relevant + NEW.amount, req.amount, tolerance
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_guard_tg
  BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- ── ASSUMPTIONS section 2.2: budget periods must match what the app resolves ──
-- Defect: 'FY2026' (annual) passed the CHECK but fiscal_period_of() always
-- returns a quarterly label, so an annual budget could never be found — the
-- position showed zero budget while commitments accrued. Until the client
-- confirms annual vs quarterly (plan section 9 Q3), only the quarterly form the
-- resolver produces is accepted. Widening this later means changing
-- fiscal_period_of and this CHECK together, in one migration.
ALTER TABLE budget_versions DROP CONSTRAINT budget_versions_period_check;
ALTER TABLE budget_versions ADD CONSTRAINT budget_versions_period_check
  CHECK (period ~ '^FY[0-9]{4}-Q[1-4]$');
ALTER TABLE budgets DROP CONSTRAINT budgets_period_check;
ALTER TABLE budgets ADD CONSTRAINT budgets_period_check
  CHECK (period ~ '^FY[0-9]{4}-Q[1-4]$');

-- ── A.5.3: the DOA activator must not approve against their own version ──────
-- The SoD trigger blocks doa_admin + approver but allowed doa_approver +
-- approver, and the route's conflict check only covered purpose='doa' steps.
-- Closing it at the role layer removes the whole class (including the
-- variance-re-approval path and any future step purpose).
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
      (NEW.role = 'sysadmin' AND ra.role IN ('approver', 'budget_owner', 'accounting', 'doa_admin', 'budget_approver', 'doa_approver'))
      OR (ra.role = 'sysadmin' AND NEW.role IN ('approver', 'budget_owner', 'accounting', 'doa_admin', 'budget_approver', 'doa_approver'))
      OR (NEW.role = 'accounting' AND ra.role = 'approver')
      OR (ra.role = 'accounting' AND NEW.role = 'approver')
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

-- ── A.8.11: reporting parity with the application's own arithmetic ───────────
-- Defect: v_budget_position was built FROM active_lines only, so committed and
-- actual movement for a category with no budget line (or a period with no
-- active version) appeared in NO row — Power BI understated spend and
-- disagreed with what approvers saw in-app. Rebuilt with a FULL OUTER JOIN,
-- mirroring server/src/budgets/position.ts exactly.
DROP VIEW reporting.v_budget_position;
CREATE VIEW reporting.v_budget_position AS
WITH active_lines AS (
  SELECT bv.cost_centre_id, bv.period, b.category_id, b.amount, b.currency
  FROM budget_versions bv
  JOIN budgets b ON b.version_id = bv.id
  WHERE bv.status = 'active'
),
req AS (
  SELECT r.id, r.cost_centre_id, r.category_id, r.amount, r.status,
         fiscal_period_of(r.approved_at) AS period
  FROM requisitions r
  WHERE r.approved_at IS NOT NULL
),
posted AS (
  SELECT i.requisition_id, sum(i.amount) AS posted_amount
  FROM invoices i
  WHERE i.status = 'posted'
  GROUP BY i.requisition_id
),
movement AS (
  SELECT r.cost_centre_id, r.period, r.category_id,
         sum(CASE WHEN r.status = 'approved'
                  THEN greatest(r.amount - coalesce(p.posted_amount, 0), 0)
                  ELSE 0 END) AS committed,
         sum(coalesce(p.posted_amount, 0)) AS actual
  FROM req r
  LEFT JOIN posted p ON p.requisition_id = r.id
  GROUP BY r.cost_centre_id, r.period, r.category_id
),
merged AS (
  SELECT coalesce(al.cost_centre_id, m.cost_centre_id) AS cost_centre_id,
         coalesce(al.period, m.period)                 AS period,
         coalesce(al.category_id, m.category_id)       AS category_id,
         coalesce(al.amount, 0)                        AS budget,
         al.currency                                   AS currency,
         coalesce(m.committed, 0)                      AS committed,
         coalesce(m.actual, 0)                         AS actual
  FROM active_lines al
  FULL OUTER JOIN movement m
    ON m.cost_centre_id = al.cost_centre_id
   AND m.period = al.period
   AND m.category_id = al.category_id
)
SELECT mg.cost_centre_id,
       cc.code       AS cost_centre_code,
       cc.department,
       mg.period,
       mg.category_id,
       cat.code      AS category_code,
       mg.currency,
       mg.budget,
       mg.committed,
       mg.actual,
       mg.budget - mg.committed - mg.actual AS available
FROM merged mg
JOIN cost_centres cc ON cc.id = mg.cost_centre_id
JOIN categories cat ON cat.id = mg.category_id;

GRANT SELECT ON reporting.v_budget_position TO massy_readonly;
