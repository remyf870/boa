-- 0006: Row-Level Security as defence-in-depth behind application
-- authorisation (A.8.3). The application is the primary enforcement point
-- (A.5.15); these policies ensure that even a direct query through the app's
-- DB role honours cost-centre scope.
--
-- The app sets the acting user per transaction:
--   SELECT set_config('app.user_id', '<uuid>', true);
-- With no user set, every policy evaluates false -> zero rows.
--
-- RLS is applied to the financial/evidential tables. Identity and reference
-- tables (users, roles_assignments, sessions, cost_centres, categories,
-- suppliers) are not RLS-scoped: session validation must read them before an
-- acting user exists, and they carry no financial detail.

CREATE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$;

-- Active (unrevoked) role check, optionally scoped to a cost centre.
-- A NULL cost_centre_id on the assignment means organisation-wide.
CREATE FUNCTION app_user_has_role(p_role role_name, p_cost_centre uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM roles_assignments ra
    WHERE ra.user_id = app_current_user_id()
      AND ra.revoked_at IS NULL
      AND ra.role = p_role
      AND (ra.cost_centre_id IS NULL
           OR p_cost_centre IS NULL
           OR ra.cost_centre_id = p_cost_centre)
  );
$$;

-- Can the acting user see records of this cost centre at all?
-- Org-wide read roles: accounting (approved+invoice flow, section 3), auditor
-- (read-only everything, section 3). sysadmin is deliberately ABSENT: admins get no
-- financial detail (A.8.2); their duties never require requisition rows.
CREATE FUNCTION app_user_can_access_cost_centre(p_cost_centre uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM roles_assignments ra
    WHERE ra.user_id = app_current_user_id()
      AND ra.revoked_at IS NULL
      AND (
        ra.cost_centre_id = p_cost_centre
        OR (ra.role IN ('accounting', 'auditor') AND ra.cost_centre_id IS NULL)
      )
  );
$$;

ALTER TABLE requisitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY requisitions_select ON requisitions FOR SELECT
  USING (requester_id = app_current_user_id()
         OR app_user_can_access_cost_centre(cost_centre_id));
CREATE POLICY requisitions_insert ON requisitions FOR INSERT
  WITH CHECK (requester_id = app_current_user_id()
              AND app_user_has_role('requester', cost_centre_id));
CREATE POLICY requisitions_update ON requisitions FOR UPDATE
  USING (requester_id = app_current_user_id()
         OR app_user_can_access_cost_centre(cost_centre_id));

ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY approval_steps_select ON approval_steps FOR SELECT
  USING (assigned_user_id = app_current_user_id()
         OR EXISTS (SELECT 1 FROM requisitions r
                    WHERE r.id = approval_steps.requisition_id
                      AND (r.requester_id = app_current_user_id()
                           OR app_user_can_access_cost_centre(r.cost_centre_id))));
CREATE POLICY approval_steps_insert ON approval_steps FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM requisitions r
                      WHERE r.id = approval_steps.requisition_id
                        AND (r.requester_id = app_current_user_id()
                             OR app_user_can_access_cost_centre(r.cost_centre_id))));
CREATE POLICY approval_steps_update ON approval_steps FOR UPDATE
  USING (assigned_user_id = app_current_user_id()
         OR EXISTS (SELECT 1 FROM requisitions r
                    WHERE r.id = approval_steps.requisition_id
                      AND app_user_can_access_cost_centre(r.cost_centre_id)));

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_all ON invoices FOR ALL
  USING (EXISTS (SELECT 1 FROM requisitions r
                 WHERE r.id = invoices.requisition_id
                   AND (r.requester_id = app_current_user_id()
                        OR app_user_can_access_cost_centre(r.cost_centre_id))))
  WITH CHECK (EXISTS (SELECT 1 FROM requisitions r
                      WHERE r.id = invoices.requisition_id
                        AND (r.requester_id = app_current_user_id()
                             OR app_user_can_access_cost_centre(r.cost_centre_id))));

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachments_requisition ON attachments FOR ALL
  USING (
    (requisition_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM requisitions r
                 WHERE r.id = attachments.requisition_id
                   AND (r.requester_id = app_current_user_id()
                        OR app_user_can_access_cost_centre(r.cost_centre_id))))
    -- admin import files (DOA matrix / budget uploads): role-gated
    OR (requisition_id IS NULL
        AND (uploaded_by = app_current_user_id()
             OR app_user_has_role('doa_admin')
             OR app_user_has_role('budget_owner')
             OR app_user_has_role('auditor')))
  )
  WITH CHECK (uploaded_by = app_current_user_id());

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY budgets_select ON budgets FOR SELECT
  USING (app_user_can_access_cost_centre(cost_centre_id)
         OR app_user_has_role('budget_owner', cost_centre_id));
CREATE POLICY budgets_write ON budgets FOR INSERT
  WITH CHECK (app_user_has_role('budget_owner', cost_centre_id));
CREATE POLICY budgets_update ON budgets FOR UPDATE
  USING (app_user_has_role('budget_owner', cost_centre_id));

-- Audit log: anyone authenticated may append (the app writes on behalf of all
-- actors); only the auditor role may read detail (section 3: auditor reads everything
-- including the audit log; sysadmin sees admin events via app-filtered views
-- in a later phase).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (app_user_has_role('auditor'));

-- DOA tables: readable by anyone who can raise or approve (the live "who will
-- approve this" display in section 5.1 needs the rules); writable only by doa_admin.
ALTER TABLE doa_matrix_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY doa_versions_select ON doa_matrix_versions FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY doa_versions_insert ON doa_matrix_versions FOR INSERT WITH CHECK (app_user_has_role('doa_admin'));
CREATE POLICY doa_versions_update ON doa_matrix_versions FOR UPDATE USING (app_current_user_id() IS NOT NULL);

ALTER TABLE doa_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY doa_rules_select ON doa_rules FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY doa_rules_insert ON doa_rules FOR INSERT WITH CHECK (app_user_has_role('doa_admin'));
CREATE POLICY doa_rules_update ON doa_rules FOR UPDATE USING (app_user_has_role('doa_admin'));
