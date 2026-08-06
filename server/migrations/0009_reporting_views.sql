-- 0009: Power BI reporting schema (plan section 6.4, A.8.11).
-- Purpose-built masked views only. massy_readonly reads THESE and nothing
-- else (0005 granted it USAGE on `reporting` only — no base tables, no
-- audit_log). Masking rule (A.8.11): expose job titles and user ids, never
-- personal names, emails or phone numbers.
--
-- Views execute with their owner's privileges (the migration/maintenance
-- role), so they see all rows regardless of RLS — that is intended for
-- reporting; scoping for interactive users happens in the application, which
-- never reads this schema.

CREATE VIEW reporting.v_requisition_facts AS
SELECT r.id                    AS requisition_id,
       r.reference,
       cc.code                 AS cost_centre_code,
       cc.department,
       cat.code                AS category_code,
       cat.name                AS category_name,
       s.name                  AS supplier_name,
       r.amount,
       r.currency,
       r.status::text          AS status,
       r.classification::text  AS classification,
       r.requester_id          AS requester_user_id, -- id, not identity (A.8.11)
       u.job_title             AS requester_job_title,
       r.created_at,
       r.submitted_at,
       r.approved_at,
       r.closed_at,
       fiscal_period_of(coalesce(r.approved_at, r.submitted_at, r.created_at)) AS fiscal_period,
       r.approval_reference
FROM requisitions r
JOIN cost_centres cc ON cc.id = r.cost_centre_id
JOIN categories cat ON cat.id = r.category_id
LEFT JOIN suppliers s ON s.id = r.supplier_id
LEFT JOIN users u ON u.id = r.requester_id;

-- Live budget position: Available = Budget − Committed − Actual (plan
-- sections 4, 5.9). Committed = approved-not-yet-closed requisitions minus
-- what their posted invoices already actualised (never below zero);
-- Actual = posted invoice amounts. Attribution period = the fiscal period of
-- final approval (ASSUMPTIONS section 2.2a).
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
)
SELECT al.cost_centre_id,
       cc.code       AS cost_centre_code,
       cc.department,
       al.period,
       al.category_id,
       cat.code      AS category_code,
       al.currency,
       al.amount     AS budget,
       coalesce(cm.committed, 0) AS committed,
       coalesce(ac.actual, 0)    AS actual,
       al.amount - coalesce(cm.committed, 0) - coalesce(ac.actual, 0) AS available
FROM active_lines al
JOIN cost_centres cc ON cc.id = al.cost_centre_id
JOIN categories cat ON cat.id = al.category_id
LEFT JOIN LATERAL (
  SELECT sum(greatest(r.amount - coalesce(p.posted_amount, 0), 0)) AS committed
  FROM req r
  LEFT JOIN posted p ON p.requisition_id = r.id
  WHERE r.cost_centre_id = al.cost_centre_id
    AND r.category_id = al.category_id
    AND r.period = al.period
    AND r.status = 'approved'
) cm ON true
LEFT JOIN LATERAL (
  SELECT sum(p.posted_amount) AS actual
  FROM req r
  JOIN posted p ON p.requisition_id = r.id
  WHERE r.cost_centre_id = al.cost_centre_id
    AND r.category_id = al.category_id
    AND r.period = al.period
) ac ON true;

-- Per-step cycle time. A step "opens" when the previous step decides (step 1
-- opens at submission).
CREATE VIEW reporting.v_approval_cycle_time AS
WITH steps AS (
  SELECT st.requisition_id, st.step_no, st.assigned_role, st.decision::text AS decision,
         st.decided_at, st.purpose,
         lag(st.decided_at) OVER (PARTITION BY st.requisition_id ORDER BY st.step_no) AS prev_decided_at
  FROM approval_steps st
)
SELECT r.reference,
       cc.code AS cost_centre_code,
       s.step_no,
       s.assigned_role,
       s.purpose,
       s.decision,
       coalesce(s.prev_decided_at, r.submitted_at) AS opened_at,
       s.decided_at,
       CASE WHEN s.decided_at IS NOT NULL
            THEN extract(epoch FROM (s.decided_at - coalesce(s.prev_decided_at, r.submitted_at))) / 86400.0
       END AS days_to_decide
FROM steps s
JOIN requisitions r ON r.id = s.requisition_id
JOIN cost_centres cc ON cc.id = r.cost_centre_id
WHERE r.submitted_at IS NOT NULL;

CREATE VIEW reporting.v_denial_reasons AS
SELECT r.reference,
       cc.code   AS cost_centre_code,
       cc.department,
       cat.code  AS category_code,
       r.amount,
       r.currency,
       st.step_no,
       st.assigned_role,
       st.decision_reason,
       st.decided_at
FROM approval_steps st
JOIN requisitions r ON r.id = st.requisition_id
JOIN cost_centres cc ON cc.id = r.cost_centre_id
JOIN categories cat ON cat.id = r.category_id
WHERE st.decision = 'denied';

-- Maverick spend (plan section 1): spend with no approval behind it. Inside
-- this app every posted invoice structurally has an approved requisition, so
-- rows here indicate integrity failures. Detecting spend keyed straight into
-- CDK requires a CDK ledger extract — blocked on the plan section 6.5 client
-- answers (ASSUMPTIONS Q5); this view is the anchor that comparison will join
-- onto.
CREATE VIEW reporting.v_maverick_spend AS
SELECT i.invoice_no,
       i.invoice_date,
       i.amount,
       i.currency,
       i.status::text AS invoice_status,
       r.reference    AS requisition_reference,
       r.status::text AS requisition_status,
       cc.code        AS cost_centre_code
FROM invoices i
JOIN requisitions r ON r.id = i.requisition_id
JOIN cost_centres cc ON cc.id = r.cost_centre_id
WHERE i.status = 'posted'
  AND (r.approval_reference IS NULL OR r.status NOT IN ('approved', 'closed'));

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO massy_readonly;
