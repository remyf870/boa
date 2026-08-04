-- 0005: least-privilege database roles (A.5.15, A.5.33, A.8.2)
--
-- massy_app       - group role the application's login user is granted.
--                   No DELETE on records, INSERT/SELECT only on audit_log.
-- massy_readonly  - group role for Power BI / reporting (Phase 3). SELECT on
--                   the `reporting` schema ONLY; no base-table access (A.8.11).
--
-- Ops provisions the actual LOGIN users per environment (separate credentials
-- per environment, A.8.31) and grants them these group roles, e.g.:
--   CREATE ROLE massy_app_svc LOGIN PASSWORD '<from-vault>';
--   GRANT massy_app TO massy_app_svc;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'massy_app') THEN
    CREATE ROLE massy_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'massy_readonly') THEN
    CREATE ROLE massy_readonly NOLOGIN;
  END IF;
END
$$;

-- Nobody creates objects in public by default
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO massy_app;

-- Records: read, create, amend - never delete (A.5.33). DELETE is deliberately
-- absent from every grant below except `sessions` (operational, not a record;
-- revocation is still a timestamp - deletion only removes long-expired rows).
GRANT SELECT, INSERT, UPDATE ON
  users,
  roles_assignments,
  cost_centres,
  categories,
  suppliers,
  budgets,
  doa_matrix_versions,
  doa_rules,
  requisitions,
  approval_steps,
  attachments,
  invoices,
  break_glass_account,
  reference_counters,
  alerts
TO massy_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO massy_app;

-- Audit log: append and read only. No UPDATE, no DELETE, no TRUNCATE - and the
-- 0003 triggers enforce the same even for over-privileged roles (A.8.15).
GRANT SELECT, INSERT ON audit_log TO massy_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO massy_app;

-- Reporting schema exists from day one so the Phase 3 views have a home and the
-- readonly role can be tested; it stays empty until Phase 3 (A.8.11 masking
-- applies to every view added here).
CREATE SCHEMA IF NOT EXISTS reporting;
GRANT USAGE ON SCHEMA reporting TO massy_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO massy_readonly;
-- massy_readonly gets nothing in `public` - no base tables, no audit_log detail.
