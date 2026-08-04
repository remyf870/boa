-- 0001: extensions and enumerated types
-- Spec: Massy-Motors-Purchase-Approval-App-Dev-Plan.md section 4
-- Migrations are immutable once applied (A.8.32). Never edit; add a new file.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid(), digest() for the audit hash chain

CREATE TYPE user_status AS ENUM ('active', 'disabled');

CREATE TYPE role_name AS ENUM (
  'requester',
  'approver',
  'accounting',
  'budget_owner',
  'doa_admin',
  'auditor',
  'sysadmin'
);

CREATE TYPE doa_version_status AS ENUM ('draft', 'active', 'superseded');

-- Cancellation is a status, never a delete (A.5.33)
CREATE TYPE requisition_status AS ENUM (
  'draft', 'submitted', 'approved', 'denied', 'closed', 'cancelled'
);

CREATE TYPE approval_decision AS ENUM ('pending', 'approved', 'denied');

CREATE TYPE attachment_type AS ENUM (
  'quote', 'invoice', 'other', 'doa_matrix', 'budget_import'
);

CREATE TYPE scan_status AS ENUM ('pending', 'clean', 'infected', 'error');

CREATE TYPE invoice_status AS ENUM ('submitted', 'posted', 'rejected');

-- A.5.12: every requisition, invoice and export carries a classification
CREATE TYPE classification AS ENUM ('internal', 'confidential');

CREATE TYPE session_via AS ENUM ('entra', 'dev', 'break_glass');

CREATE TYPE alert_severity AS ENUM ('info', 'warning', 'critical');
