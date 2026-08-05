-- 0003: append-only, hash-chained audit log (A.8.15, A.5.33, A.5.28)
--
--   row_hash = SHA256(prev_hash || canonical row contents)
--
-- Design notes (chain format v2):
--  * Canonicalisation is length-prefixed per field ('n' for NULL, else
--    '<byte-length>:<value>'), so no field content can forge an alternative
--    split of the canonical string (delimiter-injection proof).
--  * seq is allocated INSIDE the advisory-locked region by the trigger, so
--    chain order and seq order can never diverge under concurrency.
--  * The trigger and verification functions are SECURITY DEFINER: they must
--    see the whole table regardless of the caller's RLS visibility, otherwise
--    a non-auditor writer would chain onto a genesis hash it cannot see past.
--  * Honest limit (documented in docs/CRYPTO.md): the chain is tamper-EVIDENT,
--    not tamper-proof against a database superuser who disables triggers and
--    recomputes hashes or truncates the tail. Mitigations: least-privilege
--    grants (0005), and the verification job emits an anchor (max seq + tip
--    hash + row count) to the SIEM so recomputation/truncation is detectable
--    against external state.

CREATE SEQUENCE audit_log_seq;

CREATE TABLE audit_log (
  seq            bigint PRIMARY KEY, -- assigned by the chain trigger, never by callers
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
ALTER SEQUENCE audit_log_seq OWNED BY audit_log.seq;
CREATE INDEX audit_log_occurred_ix ON audit_log (occurred_at);
CREATE INDEX audit_log_actor_ix ON audit_log (actor_user_id);
CREATE INDEX audit_log_action_ix ON audit_log (action);

-- Unambiguous encoding of one nullable text field
CREATE FUNCTION audit_canonical_field(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL THEN 'n' ELSE octet_length(p)::text || ':' || p END;
$$;

-- Deterministic canonical form of one audit row (timestamp rendered at UTC;
-- jsonb text output is normalised by Postgres).
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
  SELECT audit_canonical_field(p_seq::text)
    || '|' || audit_canonical_field(to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    || '|' || audit_canonical_field(p_actor_user_id::text)
    || '|' || audit_canonical_field(p_action)
    || '|' || audit_canonical_field(p_entity_type)
    || '|' || audit_canonical_field(p_entity_id)
    || '|' || audit_canonical_field(p_before::text)
    || '|' || audit_canonical_field(p_after::text)
    || '|' || audit_canonical_field(p_ip_address::text)
    || '|' || audit_canonical_field(p_user_agent);
$$;

-- SECURITY DEFINER: the tip lookup and seq allocation must ignore the
-- caller's RLS visibility. search_path pinned per SECURITY DEFINER hygiene.
CREATE FUNCTION audit_log_hash_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  last_hash char(64);
BEGIN
  -- Serialise chain extension; seq is allocated inside the lock so chain
  -- order == seq order, always.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));
  NEW.seq := nextval('audit_log_seq');

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

-- Full-chain verification in one deterministic SQL pass. SECURITY DEFINER so
-- the verification jobs and the auditor API see the whole chain regardless of
-- RLS; returns only (seq, problem) - no payloads leak. Zero rows = intact.
CREATE FUNCTION audit_chain_defects()
RETURNS TABLE (seq bigint, problem text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
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

-- Chain anchor for external attestation: the verification job forwards this to
-- the SIEM so tail-truncation or full recomputation is detectable against
-- externally retained state (see docs/CRYPTO.md section 3).
CREATE FUNCTION audit_chain_anchor()
RETURNS TABLE (total_rows bigint, max_seq bigint, tip_hash char(64))
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT count(*), max(seq), (SELECT row_hash FROM audit_log ORDER BY seq DESC LIMIT 1)
  FROM audit_log;
$$;
