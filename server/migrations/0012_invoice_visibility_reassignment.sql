-- 0012: fixes for the 2026-08-06 workflow-consistency review (high-severity
-- findings C1/E1 — invoice rejection invisible to the requester — and D2 —
-- steps assigned to a departed approver are permanent dead-ends).

-- ── §5.4/§5.5: an invoice rejection must be explainable in-app ───────────────
-- The rejection reason previously lived only in the audit payload, which only
-- the auditor can read — the requester saw a bare 'rejected' badge with no
-- recourse. The reason now lives on the record itself (append-only history is
-- unaffected: rejected invoices are terminal and never edited afterwards).
ALTER TABLE invoices
  ADD COLUMN rejected_by uuid REFERENCES users (id),
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN rejection_reason text;

-- ── §5.2/A.5.18: steps assigned to a departed approver are re-routed ─────────
-- Disabling a user or revoking their approver role previously left their
-- pending steps as permanent dead-ends: visible in nobody's queue, decidable
-- by nobody, with no reassignment path anywhere. Re-resolution happens at the
-- moment the orphan is created (inside the admin action), against the FROZEN
-- doa_rule_snapshot descriptor for that step — the same descriptor and the
-- same candidate ordering (earliest approver grant first, then id) the engine
-- used at submit time (server/src/doa/engine.ts resolveDescriptor — keep the
-- two in sync).
--
-- SECURITY DEFINER because the caller is the sysadmin, who by A.8.2 can read
-- no financial records: the function touches requisitions internally and
-- returns only identifiers and references, never amounts. The sysadmin-role
-- guard inside makes it useless to any other caller, and the UPDATE it
-- performs can only move an UNDECIDED step to a new assignee — it can never
-- mint or alter a decision.
CREATE FUNCTION app_reassign_orphaned_steps(p_affected uuid, p_cost_centre uuid)
RETURNS TABLE (
  step_id           uuid,
  requisition_id    uuid,
  reference         text,
  step_purpose      text,
  new_assignee      uuid,
  new_assignee_name text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  st RECORD;
  v_descriptor jsonb;
  v_type text;
  v_value text;
  v_new uuid;
  v_new_name text;
BEGIN
  IF NOT app_user_has_role('sysadmin') THEN
    RAISE EXCEPTION 'only a sysadmin may reassign approval steps (A.5.18)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR st IN
    SELECT s.id AS s_id, s.step_no, s.purpose,
           r.id AS r_id, r.reference AS r_reference, r.requester_id, r.cost_centre_id,
           r.doa_rule_snapshot
    FROM approval_steps s
    JOIN requisitions r ON r.id = s.requisition_id
    WHERE s.assigned_user_id = p_affected
      AND s.decision = 'pending'
      AND ((s.purpose = 'doa' AND r.status = 'submitted')
           OR (s.purpose = 'variance_reapproval' AND r.status IN ('approved', 'closed')))
      AND (p_cost_centre IS NULL OR r.cost_centre_id = p_cost_centre)
    ORDER BY r.reference, s.step_no
  LOOP
    -- The descriptor this step was resolved from; a variance re-approval
    -- belongs to the FINAL approver level (plan §5.4).
    IF st.purpose = 'doa' THEN
      SELECT rs->'descriptor' INTO v_descriptor
      FROM jsonb_array_elements(st.doa_rule_snapshot->'resolvedSteps') rs
      WHERE (rs->>'stepNo')::int = st.step_no;
    ELSE
      SELECT rs->'descriptor' INTO v_descriptor
      FROM jsonb_array_elements(st.doa_rule_snapshot->'resolvedSteps') rs
      ORDER BY (rs->>'stepNo')::int DESC LIMIT 1;
    END IF;

    v_new := NULL;
    v_new_name := NULL;
    IF v_descriptor IS NOT NULL THEN
      v_type := v_descriptor->>'type';
      v_value := v_descriptor->>'value';
      SELECT u.id, u.display_name INTO v_new, v_new_name
      FROM users u
      JOIN roles_assignments ra ON ra.user_id = u.id
        AND ra.role = 'approver' AND ra.revoked_at IS NULL
        AND (ra.cost_centre_id = st.cost_centre_id OR ra.cost_centre_id IS NULL)
      WHERE u.status = 'active'
        AND u.id <> p_affected
        AND u.id <> st.requester_id           -- A.5.3: never the requester
        AND (v_type = 'role'
             OR (v_type = 'job_title' AND lower(u.job_title) = lower(v_value))
             OR (v_type = 'user' AND lower(u.email) = lower(v_value)))
        -- A person appearing twice in a chain approves once (§2.17): never
        -- give someone a second step on the same requisition.
        AND NOT EXISTS (SELECT 1 FROM approval_steps o
                        WHERE o.requisition_id = st.r_id AND o.id <> st.s_id
                          AND o.assigned_user_id = u.id)
      GROUP BY u.id, u.display_name
      ORDER BY min(ra.granted_at), u.id
      LIMIT 1;
    END IF;

    IF v_new IS NOT NULL THEN
      UPDATE approval_steps s SET assigned_user_id = v_new
      WHERE s.id = st.s_id AND s.decision = 'pending';
    END IF;

    step_id := st.s_id;
    requisition_id := st.r_id;
    reference := st.r_reference;
    step_purpose := st.purpose;
    new_assignee := v_new;
    new_assignee_name := v_new_name;
    RETURN NEXT;
  END LOOP;
END;
$$;
