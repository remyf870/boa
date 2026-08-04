-- 0003: append-only, hash-chained audit log (A.8.15, A.5.33, A.5.28)
--
--   row_hash = SHA256(prev_hash || canonical row contents)
--
-- The canonicalisation lives in ONE immutable SQL function used by both the
-- insert trigger and the verification job, so there is exactly one definition
-- of what gets hashed. Genesis prev_hash is 64 zero characters.

CREATE TABLE audit_log (
  seq            bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(), -- UTC per A.8.17
  actor_user_id  uuid REFERENCES users (id),         -- NULL for unauthenticated events (e.g. failed logins)
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  ip_address     inet,
  user_agent     text,
  prev_hash      char(64) NOT NULL,
  row_hash       char(64) NOT NULL
);
CREATE INDEX audit_log_occurred_ix ON audit_log (occurred_at);
CREATE INDEX audit_log_actor_ix ON audit_log (actor_user_id);
CREATE INDEX audit_log_action_ix ON audit_log (action);

-- Deterministic canonical form of one audit row (timezone-independent: the
-- timestamp is rendered explicitly at UTC; jsonb text output is normalised).
CREATE FUNCTION audit_row_canonical(
  p_seq bigint,
  p_occurred_at timestamptz,
  p_actor_user_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb,
  p_after jsonb,
  p_ip_address inet,
  p_user_agent text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_seq::text
    || '|' || to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    || '|' || coalesce(p_actor_user_id::text, '')
    || '|' || p_action
    || '|' || p_entity_type
    || '|' || coalesce(p_entity_id, '')
    || '|' || coalesce(p_before::text, '')
    || '|' || coalesce(p_after::text, '')
    || '|' || coalesce(p_ip_address::text, '')
    || '|' || coalesce(p_user_agent, '');
$$;

CREATE FUNCTION audit_log_hash_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_hash char(64);
BEGIN
  -- Serialise chain extension: concurrent inserts must not read the same tip.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));

  SELECT row_hash INTO last_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  IF last_hash IS NULL THEN
    last_hash := repeat('0', 64);
  END IF;

  NEW.prev_hash := last_hash;
  NEW.row_hash := encode(digest(
    NEW.prev_hash || '|' || audit_row_canonical(
      NEW.seq, NEW.occurred_at, NEW.actor_user_id, NEW.action, NEW.entity_type,
      NEW.entity_id, NEW.before, NEW.after, NEW.ip_address, NEW.user_agent
    ), 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_hash_chain_tg
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_hash_chain();

-- Append-only enforcement at the database layer, independent of grants (A.8.15).
CREATE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: append-only/no-delete record (ISO 27001 A.8.15 / A.5.33)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE FUNCTION reject_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on % is not permitted (ISO 27001 A.8.15 / A.5.33)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_no_update_delete_tg
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_log_no_truncate_tg
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- Full-chain verification in one deterministic SQL pass. Returns bad rows;
-- zero rows = chain intact. Used by `npm run verify-audit-chain` (A.8.16 alert
-- source) and by the A.5.28 evidence export.
CREATE FUNCTION audit_chain_defects()
RETURNS TABLE (seq bigint, problem text)
LANGUAGE sql STABLE AS $$
  WITH chained AS (
    SELECT a.seq, a.prev_hash, a.row_hash,
      lag(a.row_hash) OVER (ORDER BY a.seq) AS expected_prev,
      encode(digest(
        a.prev_hash || '|' || audit_row_canonical(
          a.seq, a.occurred_at, a.actor_user_id, a.action, a.entity_type,
          a.entity_id, a.before, a.after, a.ip_address, a.user_agent
        ), 'sha256'), 'hex') AS expected_hash
    FROM audit_log a
  )
  SELECT c.seq,
    CASE
      WHEN c.row_hash <> c.expected_hash THEN 'row contents do not match row_hash (row altered)'
      ELSE 'prev_hash does not match preceding row (chain broken / row removed)'
    END
  FROM chained c
  WHERE c.row_hash <> c.expected_hash
     OR coalesce(c.expected_prev, repeat('0', 64)) <> c.prev_hash
  ORDER BY c.seq;
$$;
