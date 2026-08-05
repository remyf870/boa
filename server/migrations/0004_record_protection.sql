-- 0004: record-protection triggers (A.5.33) and segregation-of-duties
-- constraints (A.5.3) enforced in the database, not policy.

-- Financial and evidential records are never hard-deleted. Cancellation is a
-- status. Grants also withhold DELETE (0005), but a trigger survives an
-- over-granted role or a future mistake.
CREATE TRIGGER requisitions_no_delete_tg
  BEFORE DELETE ON requisitions FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER requisitions_no_truncate_tg
  BEFORE TRUNCATE ON requisitions FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER approval_steps_no_delete_tg
  BEFORE DELETE ON approval_steps FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER approval_steps_no_truncate_tg
  BEFORE TRUNCATE ON approval_steps FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER invoices_no_delete_tg
  BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER invoices_no_truncate_tg
  BEFORE TRUNCATE ON invoices FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER budgets_no_delete_tg
  BEFORE DELETE ON budgets FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER budgets_no_truncate_tg
  BEFORE TRUNCATE ON budgets FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER doa_matrix_versions_no_delete_tg
  BEFORE DELETE ON doa_matrix_versions FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER doa_matrix_versions_no_truncate_tg
  BEFORE TRUNCATE ON doa_matrix_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER doa_rules_no_delete_tg
  BEFORE DELETE ON doa_rules FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER doa_rules_no_truncate_tg
  BEFORE TRUNCATE ON doa_rules FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER attachments_no_delete_tg
  BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER attachments_no_truncate_tg
  BEFORE TRUNCATE ON attachments FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER roles_assignments_no_delete_tg
  BEFORE DELETE ON roles_assignments FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER roles_assignments_no_truncate_tg
  BEFORE TRUNCATE ON roles_assignments FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- DOA versions may never be deleted; they also may never be edited once they
-- have left draft, except for the single legal transition active -> superseded.
CREATE FUNCTION doa_version_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'superseded DOA versions are immutable (A.5.33)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'active' THEN
    -- Only supersession is allowed, nothing else may change
    IF NEW.status <> 'superseded'
       OR NEW.version_no <> OLD.version_no
       OR NEW.uploaded_by <> OLD.uploaded_by
       OR coalesce(NEW.file_sha256, '') <> coalesce(OLD.file_sha256, '')
       OR coalesce(NEW.approved_by::text, '') <> coalesce(OLD.approved_by::text, '') THEN
      RAISE EXCEPTION 'an active DOA version can only be superseded, never edited (A.5.33)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER doa_version_immutability_tg
  BEFORE UPDATE ON doa_matrix_versions
  FOR EACH ROW EXECUTE FUNCTION doa_version_immutability();

-- Rules belonging to a non-draft version are frozen (the snapshot design in section 4
-- depends on live rules of an active version staying exactly as approved).
CREATE FUNCTION doa_rules_frozen_after_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status doa_version_status;
BEGIN
  SELECT status INTO v_status FROM doa_matrix_versions WHERE id = OLD.version_id;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'rules of a % DOA version are immutable (A.5.33)', v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER doa_rules_frozen_tg
  BEFORE UPDATE ON doa_rules
  FOR EACH ROW EXECUTE FUNCTION doa_rules_frozen_after_draft();

-- -- Segregation of duties on role grants (A.5.3, plan section 3) --------------------
-- sysadmin cannot hold approval or financial-maintenance roles;
-- accounting cannot approve; doa_admin cannot approve; auditor is read-only
-- and holds no operational role.
CREATE FUNCTION enforce_sod_on_role_grant() RETURNS trigger
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
      -- System Admin cannot approve, edit budgets, post invoices or edit the DOA (section 3)
      (NEW.role = 'sysadmin' AND ra.role IN ('approver', 'budget_owner', 'accounting', 'doa_admin'))
      OR (ra.role = 'sysadmin' AND NEW.role IN ('approver', 'budget_owner', 'accounting', 'doa_admin'))
      -- Accounting cannot approve (section 3)
      OR (NEW.role = 'accounting' AND ra.role = 'approver')
      OR (ra.role = 'accounting' AND NEW.role = 'approver')
      -- The DOA administrator cannot approve requisitions (section 3)
      OR (NEW.role = 'doa_admin' AND ra.role = 'approver')
      OR (ra.role = 'doa_admin' AND NEW.role = 'approver')
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

CREATE TRIGGER roles_assignments_sod_tg
  BEFORE INSERT OR UPDATE ON roles_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_sod_on_role_grant();

-- Attachment evidence is immutable once written: the stored bytes' identity
-- (sha256, storage_key, size, name, type, uploader) can never be re-pointed.
-- Only scan_status and classification may change (the scanner pipeline, A.8.7).
CREATE FUNCTION attachments_evidence_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.filename <> OLD.filename
     OR NEW.content_type <> OLD.content_type
     OR NEW.size_bytes <> OLD.size_bytes
     OR NEW.sha256 <> OLD.sha256
     OR NEW.storage_key <> OLD.storage_key
     OR NEW.uploaded_by <> OLD.uploaded_by
     OR NEW.uploaded_at <> OLD.uploaded_at
     OR coalesce(NEW.requisition_id::text, '') <> coalesce(OLD.requisition_id::text, '')
     OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'attachment evidence fields are immutable (A.5.33 / A.8.7)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attachments_evidence_frozen_tg
  BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_evidence_frozen();

-- section 5.3 / section 4: atomic, gap-free requisition reference issuance
CREATE FUNCTION next_reference(p_prefix text, p_year integer)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO reference_counters (prefix, year, last_no)
  VALUES (p_prefix, p_year, 1)
  ON CONFLICT (prefix, year)
  DO UPDATE SET last_no = reference_counters.last_no + 1
  RETURNING last_no INTO n;
  RETURN format('MM-%s-%s-%s', p_prefix, p_year, lpad(n::text, 4, '0'));
END;
$$;
