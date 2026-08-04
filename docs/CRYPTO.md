# Cryptography Inventory — Use of Cryptography (A.8.24)

> Required by plan §8.1 (A.8.24): document every cryptographic mechanism the app relies on —
> algorithm, parameters, purpose, and key management. Anything not listed here is not an approved
> cryptographic use in this system. Changes to this inventory follow change management (A.8.32) and
> update `/docs/CONTROL-MATRIX.md` in the same change.
>
> Last updated: 2026-08-04.

## 1. Data in transit — TLS

- **Protocol:** TLS **1.2 minimum** (1.3 preferred where both ends support it). Anything below 1.2 is refused.
- **Coverage:** all client↔app-server traffic. HTTPS only; port **80 exists solely to redirect to 443**; no application content is ever served over plaintext.
- **HSTS:** enabled (`Strict-Transport-Security` with long max-age and `includeSubDomains`) so browsers never downgrade.
- **App↔DB:** connection restricted at the firewall to the app-server IP on 5432 within the segregated db-vlan (plan §2); TLS on the Postgres connection where the deployment supports it.
- **Certificate:** issued by Massy's **internal CA** (AD Certificate Services) for the internal hostname (e.g. `purchasing.massymotors.local`), root trust distributed by GPO. Fallback if no internal PKI exists: public certificate via DNS-01 challenge (no inbound exposure required). Renewal owned by Massy IT; expiry monitored.
- **Verification:** TLS scan in Phase 4 hardening must show ≥1.2 only, valid chain, HSTS present.

## 2. Data at rest — deployment obligation

- **Database volume** (PostgreSQL 16 data directory) and **attachment storage** must reside on encrypted volumes (BitLocker on Windows Server / LUKS on Linux, per what Massy IT provisions).
- **Backups** are encrypted at the backup layer in addition to the target volume (see `docs/runbooks/backup-restore.md`).
- This is a **deployment obligation on Massy IT**, not application code — the app cannot verify it from inside. It is a go-live checklist item and is recorded as such in `/docs/CONTROL-MATRIX.md` (A.8.24, Partial).
- Volume-encryption key custody: Massy IT platform team, per their existing key-escrow practice. `TODO(client)` — confirm the mechanism chosen for the provisioned hosts.

## 3. Audit log integrity — SHA-256 hash chain

- **Construction:** each `audit_log` row carries `prev_hash` and `row_hash`, where
  `row_hash = SHA256(prev_hash || row fields)` — the canonical serialisation of the row's content
  fields (seq, occurred_at, actor, action, entity, before/after, ip, user agent) concatenated with
  the previous row's hash.
- **Genesis:** the first row uses a `prev_hash` of **64 ASCII zeros** (`"000...0"`, 64 chars).
- **Purpose:** tamper evidence (A.8.15, A.5.28) — altering or removing any historical row breaks
  every subsequent hash. A scheduled verification job re-walks the chain and any mismatch is an
  A.8.16 alert condition.
- **Note:** SHA-256 here provides integrity/tamper-evidence, not confidentiality; the log is
  additionally protected by append-only grants and a DB trigger blocking UPDATE/DELETE.

## 4. Session tokens

- **Generation:** **256-bit** random tokens from Node `crypto.randomBytes(32)` (CSPRNG). Never
  `Math.random`, never predictable identifiers.
- **Storage:** only the **SHA-256 hash** of the token is stored in the `sessions` table — a DB
  compromise does not yield usable session tokens. The plaintext token exists only in the user's
  cookie.
- **Cookie flags:** `HttpOnly` (no script access), `Secure` (TLS only), `SameSite=Lax` (CSRF
  hardening alongside the explicit CSRF protection of A.8.28).
- **Lifetime:** 30 minutes idle, 8 hours absolute (A.8.5), enforced server-side against the
  `sessions` row, not by cookie expiry alone.

## 5. Break-glass password hashing — argon2id

- The **only** password the app stores is the single documented break-glass account (A.5.16/A.5.17).
- **Algorithm:** **argon2id** with parameters: **memory 64 MiB** (65536 KiB), **iterations (time cost) 3**, **parallelism 1**. Salt generated per-hash by the argon2 library (CSPRNG); hash stored in PHC string format.
- No other password hashing code path exists in the codebase — this is the A.5.17 grep test.

## 6. Break-glass MFA — TOTP

- **Standard:** RFC 6238 TOTP — **SHA-1** HMAC, **30-second** step, **6 digits** (the RFC-default
  parameter set, chosen deliberately for authenticator-app compatibility; SHA-1 in HOTP/TOTP HMAC
  construction is not affected by SHA-1 collision weaknesses).
- Verification allows ±1 time step for clock skew; server clock is NTP-synced (A.8.17).
- The TOTP secret is held in the client's vault alongside the break-glass password (see §7), never in the repo or config files.
- Every break-glass authentication emits an alertable audit event (A.5.17 "use alerts").

## 7. Key and secret management

- **Rule:** secrets are supplied to the app **via environment only**, sourced from **Azure Key
  Vault** or **Windows DPAPI-protected configuration** with restricted ACLs (plan §2 host
  hardening). **Never** in the repo, never in a plaintext `.env` in a shared folder — CI secret
  scanning enforces the repo half of this (A.8.9).
- **Secrets in scope:** DB credentials, Entra ID client secret, session-cookie signing key,
  break-glass TOTP secret, SMTP/Graph credentials (Phase 1), backup encryption key (held by the
  backup platform, see runbook).
- **Environment separation:** production secrets exist only in production; dev/test use distinct
  throwaway credentials (A.8.31). The disposable dev database (Supabase) shares no secret with any
  other environment.
- **Rotation:** on personnel change affecting custody, on any suspected exposure (see
  `docs/runbooks/incident-response.md`), and at the client's standard rotation cadence.
  `TODO(client)` — confirm Massy's rotation cadence and the vault (Azure Key Vault vs DPAPI config)
  chosen for the provisioned hosts.

## 8. Explicit non-uses

- No application-layer field encryption in MVP (defence is access control + at-rest volume encryption + network segregation); revisit if supplier bank details ever enter scope — they are excluded in MVP precisely to avoid that (A.5.34).
- No custom or homegrown cryptographic constructions anywhere: TLS from the platform, SHA-256/`randomBytes` from Node `crypto`, argon2id and TOTP from audited libraries (`argon2`, `otplib` — see `/docs/THIRD-PARTIES.md`).
