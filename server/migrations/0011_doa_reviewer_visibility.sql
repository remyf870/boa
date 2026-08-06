-- 0011: §6.1 two-person control — activation-review visibility (2026-08-06
-- workflow-consistency review).
-- Defect: the uploader's routing-hole warnings lived only in the uploader's
-- browser session and the upload audit payload. The activator — by rule a
-- DIFFERENT person — saw none of them, so the second half of the two-person
-- control reviewed blind. Persist the warnings on the version itself so the
-- activation review screen shows the activator exactly what the uploader was
-- warned about.
ALTER TABLE doa_matrix_versions
  ADD COLUMN validation_warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The warnings are part of the record the activator judged: freeze them along
-- with the rest of the version once it leaves draft (A.5.33).
CREATE OR REPLACE FUNCTION doa_version_immutability() RETURNS trigger
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
       OR coalesce(NEW.approved_by::text, '') <> coalesce(OLD.approved_by::text, '')
       OR NEW.validation_warnings <> OLD.validation_warnings THEN
      RAISE EXCEPTION 'an active DOA version can only be superseded, never edited (A.5.33)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
