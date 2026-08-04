# Third Parties Register — Suppliers, Cloud Services and ICT Supply Chain (A.5.19–A.5.23)

> Required by plan §8.1 (A.5.19–5.23): every hosting provider, every library with a
> security-relevant role, and CDK — with what data each party touches and where that data lives.
> This register must be complete before go-live and is reviewed at every phase gate and whenever a
> dependency with a security-relevant role is added, removed, or replaced.
>
> Data-classification reminder: requisition and budget data is `Internal`; invoices are
> `Confidential` (A.5.12). "No business data" means the party never receives requisition, budget,
> invoice, supplier, or user PII data.
>
> Last updated: 2026-08-04.

## Register

| Party | Role | Data it touches | Data location | Notes |
|---|---|---|---|---|
| **Microsoft Entra ID** | Authentication (OIDC SSO, MFA, conditional access, joiner/mover/leaver) | Identity data only: user object ID, name, work email, job title, group/role claims. No requisition, budget, or invoice data. | Microsoft cloud (Azure AD tenant — Massy's existing M365 tenant) | The deliberate identity dependency (plan §2). App registration not yet granted — `TODO(client)`, go-live blocker (ASSUMPTIONS Q8). Disable-propagation window documented in ASSUMPTIONS §2.10. |
| **Microsoft Graph API / internal SMTP relay** | Outbound notification email (approval requests, denials, reminders) | Recipient work email address + deep links only. Emails **never** contain amounts, supplier names, or attachments (A.5.14). | Microsoft cloud (Graph) or on-prem relay — whichever Massy IT designates | **Deferred to Phase 1** (notifications feature). Choice of Graph vs internal relay to be made with Massy IT; firewall table in plan §2 covers both. |
| **Internal hosting (Massy corporate network)** | Production runtime: app server, PostgreSQL 16 DB server, attachment storage, backup target | **All application data** — requisitions, approvals, budgets, invoices, attachments, audit log, user records | On-premises, inside the Massy network boundary; no public DNS, no inbound perimeter rule (plan §2) | Two hosts on separate VLANs (A.8.22); DB server has no outbound internet route (A.8.21). Assumed jurisdiction Trinidad & Tobago — ASSUMPTIONS Q7. |
| **GitHub + GitHub Actions** | Source code hosting, CI (build, tests, dependency and secret scanning), branch protection | **Source code only.** Zero secrets in the repo (A.8.9); zero business data; synthetic test fixtures only (A.8.33). | GitHub cloud (Microsoft) | CI gates: `npm audit` fail-on-High/Critical (A.8.8), secret scanner (A.8.9). Branch protection on `main` (A.8.25). |
| **npm registry** | Build-time package source for Node dependencies | None at runtime. Build metadata only (package names/versions requested). | npmjs.com (cloud) | Lockfile-pinned installs; dependency scanning in CI (A.8.8). Plan §2 allows an internal artifact mirror/proxy if Massy IT prefers. |
| **npm dependency: `fastify`** | HTTP server framework — routing, request lifecycle, security-header and rate-limit plugins hang off it | Handles all request/response traffic in-process on the app server | Runs on-prem app server (code from npm registry) | Security-relevant: the perimeter of every server-side control (A.5.15, A.8.28). Version pinned; CVE-watched via CI scanning. |
| **npm dependency: `openid-client`** | OIDC relying-party client for Entra ID (authorization code + PKCE) | ID tokens, auth codes, client secret (from vault) in-process | Runs on-prem app server | Security-relevant: implements A.8.5 flow correctly (nonce, state, PKCE). |
| **npm dependency: `argon2`** | Password hashing for the single break-glass account | Break-glass credential hash only | Runs on-prem app server | Security-relevant: A.5.17. Parameters documented in `docs/CRYPTO.md` §5. Only password-hashing code path in the app. |
| **npm dependency: `otplib`** | TOTP (RFC 6238) verification for break-glass MFA | Break-glass TOTP secret (from vault) in-process | Runs on-prem app server | Security-relevant: A.5.17 MFA on the only local account. Parameters in `docs/CRYPTO.md` §6. |
| **npm dependency: `pg`** | PostgreSQL driver — parameterised queries | All application data in transit app↔DB | Runs on-prem app server; connects only to on-prem DB (5432, app-server IP only) | Security-relevant: parameterisation is the injection defence (A.8.28). |
| **npm dependency: `zod`** | Server-side input validation on every route | All inbound request payloads | Runs on-prem app server | Security-relevant: A.8.28 server-side validation. |
| **npm dependency: `exceljs`** *(planned, Phase 3)* | Server-side generation of real `.xlsx` exports with classification labels | Requisition/approval/budget data being exported (`Internal`/`Confidential`) | Runs on-prem app server | Security-relevant: export labelling (A.5.13) and export logging hook point (A.8.12). Added to CI scanning when introduced. |
| **Supabase** | **DEV/TEST ONLY** — disposable hosted PostgreSQL used during development | **Synthetic data only** (A.8.33). Never production data, never real user PII, never production credentials. | Supabase cloud | **To be decommissioned before go-live** (project deleted, credentials rotated out). Production DB is on-prem PostgreSQL 16 per plan §2. Recorded in ASSUMPTIONS §2.14. Not a production dependency. |
| **CDK (DMS vendor)** | System of record for the ledger. **MVP: no integration** — reference fields + Excel batch export keyed in manually by Accounting (plan §6.5). | MVP: none (no connection exists). App stores CDK-shaped references (`cdk_vendor_ref`, `gl_account_code`, `cdk_reference`) locally. | CDK hosting model **unknown** — `TODO(client)` (ASSUMPTIONS Q5) | **Phase 2 pending client answers**: product/edition, API/ODBC licensing, contract permissions, vendor-relationship owner. A live integration will trigger a supplier security assessment under A.5.19–A.5.23 before any data flows. |
| **Power BI** | Finance analytics over the read-only, PII-masked reporting schema (plan §6.4) | Masked reporting views only: requisition facts, budget position, cycle times, denial reasons, maverick spend. No audit-log detail, no personal contact details (A.8.11). | **Pending client decision Q12**: Power BI Service (cloud — data leaves the boundary, triggers A.5.23 assessment) vs Power BI Report Server (on-prem — data stays inside) | Dedicated read-only DB user, SELECT on reporting schema only. On-prem data gateway is outbound-only. Decision ties to jurisdiction Q7. `TODO(client)`. |

## Review and change rules

- Adding, removing, or replacing any dependency with a security-relevant role requires an update to
  this register in the same change, plus CI scanning coverage (A.8.8).
- Any new party that would receive business data (`Internal` or above) requires a documented
  A.5.19–A.5.23 assessment **before** the first data flow — this applies specifically to any future
  CDK integration (Phase 2) and to Power BI Service if chosen.
- Go-live checklist items from this register: Supabase project decommissioned; Entra app
  registration in place; Graph-vs-SMTP decision recorded; Power BI hosting decision recorded.
