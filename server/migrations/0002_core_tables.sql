-- 0002: core tables per plan section 4, plus operational tables required by section 8 gates
-- (sessions -> A.8.5, banner acknowledgement -> A.5.10, break-glass -> A.5.17,
--  alerts -> A.8.16, reference_counters -> section 5.3). All timestamps timestamptz (A.8.17).

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_object_id       text NOT NULL UNIQUE,
  email                 text NOT NULL,
  display_name          text NOT NULL,
  job_title             text,
  status                user_status NOT NULL DEFAULT 'active',
  -- A.5.10 acceptable-use banner acknowledgement, recorded per user
  banner_acknowledged_at timestamptz,
  banner_version        integer,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE cost_centres (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  department  text NOT NULL,
  parent_id   uuid REFERENCES cost_centres (id),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Roles are assigned per user per cost centre (section 3). cost_centre_id NULL means
-- organisation-wide and is only valid for org-scoped roles.
-- A.5.18: grants record who, when and why; revocation is a timestamp, not a delete.
CREATE TABLE roles_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id),
  role            role_name NOT NULL,
  cost_centre_id  uuid REFERENCES cost_centres (id),
  granted_by      uuid NOT NULL REFERENCES users (id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  granted_reason  text NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users (id),
  revoked_reason  text,
  CONSTRAINT cost_centre_scoped_roles_need_cost_centre CHECK (
    role NOT IN ('requester', 'approver', 'budget_owner') OR cost_centre_id IS NOT NULL
  ),
  -- Org-wide roles are org-wide, full stop: a "scoped sysadmin/auditor" grant
  -- would otherwise satisfy org-wide role checks and confer over-broad access
  -- (A.5.15, A.8.2 - adversarial review finding).
  CONSTRAINT org_wide_roles_have_no_cost_centre CHECK (
    role NOT IN ('sysadmin', 'auditor', 'accounting', 'doa_admin') OR cost_centre_id IS NULL
  ),
  CONSTRAINT revocation_is_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL)
  )
);
-- One live grant per (user, role, scope)
CREATE UNIQUE INDEX roles_assignments_live_uq
  ON roles_assignments (user_id, role, coalesce(cost_centre_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX roles_assignments_user_live_ix ON roles_assignments (user_id) WHERE revoked_at IS NULL;

CREATE TABLE categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  gl_account_code  text,
  cdk_account_ref  text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- A.5.34: deliberately NO bank/payment fields. Supplier banking data belongs in
-- CDK; holding it here creates fraud risk with no benefit. Do not add such
-- columns without a documented client decision and a control review.
CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  cdk_vendor_ref  text,
  tax_id          text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Single files table for all uploads so the malware-scan pipeline (A.8.7) and
-- classification labels (A.5.12) are uniform. Requisition-scoped types require
-- a requisition; admin-import types must not have one.
CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id  uuid, -- FK added in this file after requisitions exists
  type            attachment_type NOT NULL,
  filename        text NOT NULL,
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  sha256          char(64) NOT NULL,
  storage_key     text NOT NULL UNIQUE,
  scan_status     scan_status NOT NULL DEFAULT 'pending',
  uploaded_by     uuid NOT NULL REFERENCES users (id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  classification  classification NOT NULL DEFAULT 'internal',
  CONSTRAINT requisition_scope_matches_type CHECK (
    (type IN ('quote', 'invoice', 'other') AND requisition_id IS NOT NULL)
    OR (type IN ('doa_matrix', 'budget_import') AND requisition_id IS NULL)
  )
);

CREATE TABLE budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_centre_id  uuid NOT NULL REFERENCES cost_centres (id),
  -- e.g. FY2026 or FY2026-Q1. TODO(client) section 9 Q3: annual vs quarterly.
  period          text NOT NULL CHECK (period ~ '^FY[0-9]{4}(-Q[1-4])?$'),
  category_id     uuid NOT NULL REFERENCES categories (id),
  amount          numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency        char(3) NOT NULL,
  source_file_id  uuid REFERENCES attachments (id),
  version         integer NOT NULL,
  approved_by     uuid REFERENCES users (id),
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cost_centre_id, category_id, period, version)
);

CREATE TABLE doa_matrix_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_no      integer NOT NULL UNIQUE,
  effective_from  timestamptz,
  effective_to    timestamptz,
  status          doa_version_status NOT NULL DEFAULT 'draft',
  source_file_id  uuid REFERENCES attachments (id),
  file_sha256     char(64),
  uploaded_by     uuid NOT NULL REFERENCES users (id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid REFERENCES users (id),
  approved_at     timestamptz,
  -- Two-person rule (section 6.1, A.5.3): the uploader can never activate their own version
  CONSTRAINT two_person_rule CHECK (approved_by IS NULL OR approved_by <> uploaded_by),
  CONSTRAINT active_requires_approval CHECK (
    status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);
-- Exactly one active version at a time
CREATE UNIQUE INDEX doa_matrix_one_active_uq ON doa_matrix_versions ((true)) WHERE status = 'active';

CREATE TABLE doa_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id         uuid NOT NULL REFERENCES doa_matrix_versions (id),
  category_id        uuid NOT NULL REFERENCES categories (id),
  cost_centre_id     uuid REFERENCES cost_centres (id), -- NULL = all cost centres
  min_amount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  max_amount         numeric(14,2), -- NULL = no upper bound
  currency           char(3) NOT NULL,
  -- Ordered list of approver descriptors, e.g. [{"type":"role","role":"approver","label":"Dept Manager"}, ...]
  approval_sequence  jsonb NOT NULL CHECK (
    jsonb_typeof(approval_sequence) = 'array' AND jsonb_array_length(approval_sequence) >= 1
  ),
  requires_quotes    integer NOT NULL DEFAULT 0 CHECK (requires_quotes BETWEEN 0 AND 10),
  notes              text,
  CONSTRAINT band_is_ordered CHECK (max_amount IS NULL OR max_amount > min_amount)
);
CREATE INDEX doa_rules_version_ix ON doa_rules (version_id);

CREATE TABLE requisitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE, -- MM-LEA-2026-0001 (section 5.3)
  requester_id        uuid NOT NULL REFERENCES users (id),
  cost_centre_id      uuid NOT NULL REFERENCES cost_centres (id),
  category_id         uuid NOT NULL REFERENCES categories (id),
  supplier_id         uuid REFERENCES suppliers (id),
  description         text NOT NULL,
  justification       text NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  currency            char(3) NOT NULL,
  needed_by           date,
  status              requisition_status NOT NULL DEFAULT 'draft',
  doa_version_id      uuid REFERENCES doa_matrix_versions (id),
  -- Design rule section 4.1: the exact rule that applied at submit time, frozen forever
  doa_rule_snapshot   jsonb,
  approval_reference  text UNIQUE, -- issued only on final approval (section 5.3)
  classification      classification NOT NULL DEFAULT 'internal',
  created_at          timestamptz NOT NULL DEFAULT now(),
  submitted_at        timestamptz,
  closed_at           timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submitted_state_is_complete CHECK (
    status IN ('draft', 'cancelled')
    OR (submitted_at IS NOT NULL AND doa_version_id IS NOT NULL AND doa_rule_snapshot IS NOT NULL)
  ),
  -- 'cancelled' stays in the list: an approved requisition may be cancelled
  -- (supplier fell through) and its issued reference is a record that must
  -- survive the cancellation (A.5.33).
  CONSTRAINT approval_reference_only_when_approved CHECK (
    approval_reference IS NULL OR status IN ('approved', 'closed', 'cancelled')
  )
);
CREATE INDEX requisitions_cost_centre_ix ON requisitions (cost_centre_id);
CREATE INDEX requisitions_requester_ix ON requisitions (requester_id);
CREATE INDEX requisitions_status_ix ON requisitions (status);

ALTER TABLE attachments
  ADD CONSTRAINT attachments_requisition_fk
  FOREIGN KEY (requisition_id) REFERENCES requisitions (id);
CREATE INDEX attachments_requisition_ix ON attachments (requisition_id);

CREATE TABLE approval_steps (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id                uuid NOT NULL REFERENCES requisitions (id),
  step_no                       integer NOT NULL CHECK (step_no >= 1),
  assigned_role                 text,
  assigned_user_id              uuid REFERENCES users (id),
  delegate_of_user_id           uuid REFERENCES users (id), -- section 5.2 delegation records both identities
  decision                      approval_decision NOT NULL DEFAULT 'pending',
  decision_reason               text,
  decided_at                    timestamptz,
  budget_remaining_at_decision  numeric(14,2),
  ip_address                    inet,
  user_agent                    text,
  UNIQUE (requisition_id, step_no),
  -- section 5.2: a reason is mandatory on denial
  CONSTRAINT denial_requires_reason CHECK (decision <> 'denied' OR decision_reason IS NOT NULL),
  CONSTRAINT decided_steps_have_timestamp CHECK (
    (decision = 'pending' AND decided_at IS NULL) OR (decision <> 'pending' AND decided_at IS NOT NULL)
  )
);
CREATE INDEX approval_steps_requisition_ix ON approval_steps (requisition_id);
CREATE INDEX approval_steps_assignee_pending_ix ON approval_steps (assigned_user_id) WHERE decision = 'pending';

CREATE TABLE invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id        uuid NOT NULL REFERENCES requisitions (id),
  attachment_id         uuid NOT NULL REFERENCES attachments (id),
  invoice_no            text NOT NULL, -- same supplier invoice recorded twice = paid twice; see UNIQUE below
  invoice_date          date NOT NULL,
  amount                numeric(14,2) NOT NULL CHECK (amount > 0),
  currency              char(3) NOT NULL,
  status                invoice_status NOT NULL DEFAULT 'submitted',
  posted_by             uuid REFERENCES users (id),
  posted_at             timestamptz,
  cdk_reference         text,
  variance_vs_approved  numeric(8,4), -- fraction, e.g. 0.0532 = 5.32% over approved
  classification        classification NOT NULL DEFAULT 'confidential', -- A.5.12
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posted_state_is_complete CHECK (
    status <> 'posted' OR (posted_by IS NOT NULL AND posted_at IS NOT NULL AND cdk_reference IS NOT NULL)
  ),
  UNIQUE (requisition_id, invoice_no)
);
CREATE INDEX invoices_requisition_ix ON invoices (requisition_id);
CREATE INDEX invoices_status_ix ON invoices (status);

-- -- Operational tables --------------------------------------------------------

-- A.8.5: server-side sessions; cookie carries a random token, DB stores its hash.
CREATE TABLE sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id),
  token_hash           char(64) NOT NULL UNIQUE,
  csrf_token           char(64) NOT NULL,
  via                  session_via NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  ip_address           inet,
  user_agent           text
);
CREATE INDEX sessions_user_ix ON sessions (user_id);

-- A.5.17: the single documented break-glass account. One row, ever.
CREATE TABLE break_glass_account (
  id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  username             text NOT NULL,
  password_hash        text NOT NULL,
  totp_secret_enc      text NOT NULL, -- AES-256-GCM, key derived from BREAK_GLASS_KEY env
  enabled              boolean NOT NULL DEFAULT true,
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  -- TOTP replay protection: a code's time step may only be consumed once
  last_totp_step       bigint,
  last_used_at         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- section 5.3 reference issuance: MM-<DEPT>-<YYYY>-<seq>, gap-free per prefix+year
CREATE TABLE reference_counters (
  prefix   text NOT NULL,
  year     integer NOT NULL,
  last_no  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);

-- A.8.16: alert conditions detected by the monitoring job land here (and in the SIEM)
CREATE TABLE alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raised_at        timestamptz NOT NULL DEFAULT now(),
  rule             text NOT NULL,
  severity         alert_severity NOT NULL,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users (id)
);
CREATE INDEX alerts_open_ix ON alerts (raised_at) WHERE acknowledged_at IS NULL;
