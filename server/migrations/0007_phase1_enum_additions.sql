-- 0007: enum additions for Phases 1-3.
-- ALTER TYPE ... ADD VALUE may run inside a transaction (PG 12+) but the new
-- value cannot be USED in the same transaction — hence this file contains
-- ONLY the additions; every use of them lives in 0008+.

-- Budget governance (plan section 5.9): the org-wide role that approves budget
-- versions. Which real party holds it (Board of Directors / Finance Director)
-- is TODO(client), plan section 9 Q13 — a grant, not code.
ALTER TYPE role_name ADD VALUE IF NOT EXISTS 'budget_approver';

-- DOA activation (plan section 6.1): the second person of the two-person rule.
-- Mapped to the Finance Director per the plan; data-driven via role grant.
ALTER TYPE role_name ADD VALUE IF NOT EXISTS 'doa_approver';

-- Invoice variance beyond tolerance requires re-approval by the final approver
-- before Accounting may post it (plan section 5.4).
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'pending_reapproval';
