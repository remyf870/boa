-- 0013: enum additions for the 2026-08-08 client change wave ("Changes to make
-- to BOA app"). ALTER TYPE ... ADD VALUE may run inside a transaction (PG 12+)
-- but the new value cannot be USED in the same transaction — hence this file
-- contains ONLY the additions; every use of them lives in 0014+ (0007 pattern).

-- Supplier governance (client change list, "System Admin UI" + tier features):
-- suppliers now enter through a request → approve workflow. The org-wide role
-- that approves supplier requests (held by Tier-4 approvers per the Leasing
-- DOA: Snr Manager Rentals / AVP Finance).
ALTER TYPE role_name ADD VALUE IF NOT EXISTS 'supplier_approver';

-- Bulk upload of the approved-supplier list by the sysadmin is evidenced like
-- DOA/budget imports: the workbook is stored as an attachment of this type.
ALTER TYPE attachment_type ADD VALUE IF NOT EXISTS 'supplier_import';
