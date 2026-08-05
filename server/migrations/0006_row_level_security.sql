-- 0006: Row-Level Security as defence-in-depth behind application
-- authorisation (A.8.3). The application is the primary enforcement point
-- (A.5.15); these policies ensure that even a direct query through the app's
-- DB role honours cost-centre scope AND role capability (section 3):
--   requester    - own requisitions only
--   approver     - records of their cost centre(s)
--   accounting   - org-wide read; may update invoices (posting)
--   budget_owner - budgets of their cost centre(s)
--   doa_admin    - DOA tables only
--   auditor      - org-wide READ ONLY, never any write
--   sysadmin     - NO financial records at all (A.8.2)
--
-- The app sets the acting user per transaction:
--   SELECT set_config('app.user_id', '<uuid>', true);
-- With no user set, every policy evaluates false -> zero rows.
--
-- Deployment model (also enforced by a production startup guard in the app):
-- the application connects as a member of massy_app, which does NOT own the
-- tables. Owners bypass RLS; the owner role is for migrations/maintenance
-- only. Identity/reference tables (users, roles_assignments, sessions,
-- cost_centres, categories, suppliers) are not RLS-scoped: session validation
-- must read them before an acting user exists, and they carry no financial
-- detail.

CREATE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$;

-- Role check. p_cost_centre NULL means "org-wide check": only an org-wide
-- (NULL-scoped) grant satisfies it. A scoped grant satisfies only its own
-- cost centre. (0002's org_wide_roles_have_no_cost_centre CHECK guarantees
-- sysadmin/auditor/accounting/doa_admin grants are always org-wide.)
CREATE FUNCTION app_user_has_role(p_role role_name, p_cost_centre uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM roles_assignments ra
    WHERE ra.user_id = app_current_user_id()
      AND ra.revoked_at IS NULL
      AND ra.role = p_role
      AND (
        (p_cost_centre IS NULL AND ra.cost_centre_id IS NULL)
        OR (p_cost_centre IS NOT NULL AND (ra.cost_centre_id IS NULL OR ra.cost_centre_id = p_cost_centre))
      )
  );
$$;

-- READ access to financial records of a cost centre. Role-filtered: only
-- approvers of that cost centre and org-wide accounting/auditor qualify.
-- Requesters see their own records via requester_id predicates, not here.
-- sysadmin and doa_admin are deliberately absent (A.8.2, section 3).
CREATE FUNCTION app_user_can_read_cost_centre(p_cost_centre uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM roles_assignments ra
    WHERE ra.user_id = app_current_user_id()
      AND ra.revoked_at IS NULL
      AND (
        (ra.role = 'approver' AND ra.cost_centre_id = p_cost_centre)
        OR (ra.role IN ('accounting', 'auditor') AND ra.cost_centre_id IS NULL)
      )
  );
$$;

-- ── requisitions ─────────────────────────────────────────────────────────────
ALTER TABLE requisitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY requisitions_select ON requisitions FOR SELECT
  USING (requester_id = app_current_user_id()
         OR app_user_can_read_cost_centre(cost_centre_id));
CREATE POLICY requisitions_insert ON requisitions FOR INSERT
  WITH CHECK (requester_id = app_current_user_id()
              AND app_user_has_role('requester', cost_centre_id));
-- WITH CHECK re-asserts the requester role in the NEW row's cost centre, so a
-- requisition cannot be moved into a cost centre the writer holds no role in.
CREATE POLICY requisitions_update ON requisitions FOR UPDATE
  USING (requester_id = app_current_user_id())
  WITH CHECK (requester_id = app_current_user_id()
              AND app_user_has_role('requester', cost_centre_id));

-- ── approval_steps ───────────────────────────────────────────────────────────
ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY approval_steps_select ON approval_steps FOR SELECT
  USING (assigned_user_id = app_current_user_id()
         OR delegate_of_user_id = app_current_user_id()
         OR EXISTS (SELECT 1 FROM requisitions r
                    WHERE r.id = approval_steps.requisition_id
                      AND (r.requester_id = app_current_user_id()
                           OR app_user_can_read_cost_centre(r.cost_centre_id))));
CREATE POLICY approval_steps_insert ON approval_steps FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM requisitions r
                      WHERE r.id = approval_steps.requisition_id
                        AND r.requester_id = app_current_user_id()));
-- Only the assigned approver may decide their own step. Auditor/accounting
-- read via SELECT; they can never write here (section 3).
CREATE POLICY approval_steps_update ON approval_steps FOR UPDATE
  USING (assigned_user_id = app_current_user_id())
  WITH CHECK (assigned_user_id = app_current_user_id());

-- ── invoices ─────────────────────────────────────────────────────────────────
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (EXISTS (SELECT 1 FROM requisitions r
                 WHERE r.id = invoices.requisition_id
                   AND (r.requester_id = app_current_user_id()
                        OR app_user_can_read_cost_centre(r.cost_centre_id))));
-- The requester submits the invoice against their own requisition (section 5.4)
CREATE POLICY invoices_insert ON invoices FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM requisitions r
                      WHERE r.id = invoices.requisition_id
                        AND r.requester_id = app_current_user_id()));
-- Accounting marks invoices posted (section 5.5); nobody else updates them
CREATE POLICY invoices_update ON invoices FOR UPDATE
  USING (app_user_has_role('accounting'))
  WITH CHECK (app_user_has_role('accounting'));

-- ── attachments ──────────────────────────────────────────────────────────────
-- Evidence fields are additionally frozen by trigger (0004). No UPDATE policy
-- exists for end users: scan_status transitions belong to the scanner service
-- identity (Phase 2), which will get its own policy.
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachments_select ON attachments FOR SELECT
  USING (
    uploaded_by = app_current_user_id()
    OR (requisition_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM requisitions r
                    WHERE r.id = attachments.requisition_id
                      AND (r.requester_id = app_current_user_id()
                           OR app_user_can_read_cost_centre(r.cost_centre_id))))
    OR (requisition_id IS NULL
        AND (app_user_has_role('doa_admin') OR app_user_has_role('auditor')))
  );
CREATE POLICY attachments_insert ON attachments FOR INSERT
  WITH CHECK (uploaded_by = app_current_user_id());

-- ── budgets ──────────────────────────────────────────────────────────────────
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY budgets_select ON budgets FOR SELECT
  USING (app_user_can_read_cost_centre(cost_centre_id)
         OR app_user_has_role('budget_owner', cost_centre_id)
         OR app_user_has_role('approver', cost_centre_id)); -- approvers see budget position (section 5.2)
CREATE POLICY budgets_insert ON budgets FOR INSERT
  WITH CHECK (app_user_has_role('budget_owner', cost_centre_id));
CREATE POLICY budgets_update ON budgets FOR UPDATE
  USING (app_user_has_role('budget_owner', cost_centre_id))
  WITH CHECK (app_user_has_role('budget_owner', cost_centre_id));

-- ── audit_log ────────────────────────────────────────────────────────────────
-- Anyone authenticated may append (the app writes on behalf of all actors);
-- only the auditor role reads detail (section 3). The chain trigger and the
-- verification functions are SECURITY DEFINER (0003), so chaining and
-- verification are unaffected by this policy.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (app_user_has_role('auditor'));

-- ── DOA tables ───────────────────────────────────────────────────────────────
-- Readable by anyone authenticated (the live "who will approve this" display
-- in section 5.1 needs the rules); writable only by doa_admin. The Phase 1
-- activation flow (second-person approval, section 6.1) will add a narrowly
-- scoped activation path for the approving role at that point.
ALTER TABLE doa_matrix_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY doa_versions_select ON doa_matrix_versions FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY doa_versions_insert ON doa_matrix_versions FOR INSERT WITH CHECK (app_user_has_role('doa_admin'));
CREATE POLICY doa_versions_update ON doa_matrix_versions FOR UPDATE
  USING (app_user_has_role('doa_admin'))
  WITH CHECK (app_user_has_role('doa_admin'));

ALTER TABLE doa_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY doa_rules_select ON doa_rules FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY doa_rules_insert ON doa_rules FOR INSERT WITH CHECK (app_user_has_role('doa_admin'));
CREATE POLICY doa_rules_update ON doa_rules FOR UPDATE
  USING (app_user_has_role('doa_admin'))
  WITH CHECK (app_user_has_role('doa_admin'));
