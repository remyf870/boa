# Massy Motors — Purchase Approval & DOA Enforcement App
## Development Plan (MVP)

---

## 0. INSTRUCTIONS TO THE AI BUILDING THIS

> **Read this first and re-read it before every feature you implement.**
>
> 1. Section 8 ("ISO 27001 Compliance Gates") is **normative**. Before you mark any feature complete, check it against every control in Section 8 that applies to it. If a feature touches identity, data, files, logs, exports, or approvals — it applies.
> 2. Do **not** implement a control by writing a comment saying it's handled. Each gate has an acceptance test. Implement the test.
> 3. Where this plan says "configurable", it must be **data in the database**, not a constant in code. The Delegation of Authority (DOA) is still being drafted by the client and **will change**. Any hardcoded approval threshold is a defect.
> 4. Where you must make an assumption, write it into `/docs/ASSUMPTIONS.md` with a `TODO(client)` marker instead of silently choosing.
> 5. Do not add features not listed here. Scope creep on an MVP that has to pass an audit is expensive.

---

## 1. What this app is

A **purchase requisition and approval logbook** that enforces Massy Motors' Delegation of Authority. Nobody buys anything until the app says they can, and every request — approved or denied — leaves a permanent, tamper-evident record.

**The core loop:**

```
Requester raises requisition
  → app resolves the DOA rule (category × cost centre × amount)
  → routes to the correct approver(s) in sequence
  → each approver sees the budget impact before deciding
  → APPROVED  → app issues an Approval Reference → requester may contact supplier
     DENIED   → logged with reason, requester notified, no reference issued
  → requester uploads the supplier invoice against the Approval Reference
  → Accounting sees it in their queue, keys it into CDK, marks it posted
  → requisition closes; budget moves from committed to actual
```

**First rollout:** Leasing department only (single department pilot), then expand.

### What it is *not*
- Not a replacement for CDK. CDK stays the system of record for the ledger.
- Not a procurement/sourcing suite. No RFQ workflow, no supplier onboarding, no contract management in MVP.
- Not a payments system. It never touches money movement.

### An honest limit on "no purchase before approval"
Software cannot physically stop someone phoning a supplier. What the app *can* do, and must:
- Issue an **Approval Reference** that Accounting is instructed to require before posting any invoice.
- **Reject invoice upload** where no matching approved requisition exists.
- Produce a **Maverick Spend report** — invoices posted in CDK with no corresponding approval — so the gap is visible and manageable.

Enforcement = app (preventive) + policy (procedural) + report (detective). Say this to the client plainly; do not oversell.

---

## 2. Recommended stack — and the easiest desktop path

### Desktop delivery: build a web app, install it as a desktop app

Do **not** build a native `.exe` for the MVP. Build a browser app and deploy it via **Microsoft Edge → "Install this site as an app"**. Users get a desktop icon, a dedicated window with no browser chrome, and it looks and behaves like installed software. Zero packaging, zero installer, zero update distribution — you push to the server and every desktop is current the next morning.

This matters for ISO too: patching is instant and centrally controlled (A.8.8, A.8.19), and there's no application data sitting on endpoints (A.8.1).

If IT later insists on a signed `.exe`, wrap the same app in **Tauri** in a day. Don't do it now.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Fast build, huge model familiarity, PWA-ready |
| UI | Tailwind + shadcn/ui | Clean, dense, desktop-appropriate; accessible defaults |
| Tables | TanStack Table | Sorting/filtering/pagination for the logbook views |
| Backend | Node 20 + Fastify + TypeScript | Single language across stack; fast to build |
| DB | PostgreSQL 16 | Row-level security, JSONB for rule snapshots, strong constraints |
| ORM | Prisma or Drizzle | Typed migrations = auditable schema change history (A.8.32) |
| Auth | **Microsoft Entra ID (Azure AD) SSO via OIDC** | See below — this is the single most important decision |
| Files | Server filesystem or Azure Blob, private, signed short-lived URLs | Never serve attachments from a public path |
| Email | Microsoft Graph API or internal SMTP relay | Approval notifications with deep links |
| Excel | ExcelJS (server-side generation) | Real `.xlsx` with formatting, not CSV-renamed |
| Hosting | Internal Windows/Linux server on the Massy network, **or** their Azure tenant | Keeps data inside the org boundary |

**Alternative if Massy IT mandates a Microsoft-only stack:** Blazor Server + SQL Server + Entra ID. Same design, same controls. Pick one and commit — do not hedge.

### Authenticate with Entra ID. This is not optional.

Massy already runs Microsoft 365. Using Entra ID SSO means the app **inherits** their MFA, password policy, conditional access, and — critically — their joiner/mover/leaver process. When someone leaves, IT disables the account and their approval authority dies with it, automatically.

Rolling your own username/password table means re-implementing and re-proving A.5.16, A.5.17, A.5.18 and A.8.5 from scratch, and it will be the first thing an auditor attacks. Build one local break-glass admin account, MFA-enforced, documented, monitored — nothing more.

### Network architecture — where this actually sits

**This app is internal-only.** "Web app" describes how it is delivered (HTTP, browser), not where it is exposed. It sits on the corporate network with no public DNS record and no inbound rule on the perimeter firewall. From the internet it does not exist.

```
              INTERNET
                 │
        ╔════════╧════════╗   ← no inbound rule, no NAT, no public DNS record
        ║ Perimeter FW    ║      (outbound only, allowlisted — see table)
        ╚════════╤════════╝
   ┌─────────────┴──────────────────────────────────────────┐
   │  MASSY CORPORATE NETWORK                               │
   │                                                        │
   │   ┌──────────────┐         ┌────────────────────────┐  │
   │   │ Workstations │──443──▶ │ APP SERVER  (app-vlan) │  │
   │   │ Edge / PWA   │         │ Fastify + static SPA   │  │
   │   └──────────────┘         └───────┬────────────────┘  │
   │                                    │ 5432               │
   │   ┌──────────────┐                 ▼                    │
   │   │ Power BI     │         ┌────────────────────────┐   │
   │   │ on-prem GW   │──5432──▶│ DB SERVER   (db-vlan)  │   │
   │   │ (outbound    │ (read-  │ PostgreSQL + files     │   │
   │   │  only ─▶ MS) │  only)  │ NO OUTBOUND INTERNET   │   │
   │   └──────────────┘         └───────┬────────────────┘   │
   │                                    │                    │
   │                            ┌───────▼────────────────┐   │
   │                            │ BACKUP TARGET          │   │
   │                            │ separate host,         │   │
   │                            │ immutable / offline copy│  │
   │                            └────────────────────────┘   │
   └────────────────────────────────────────────────────────┘
```

**Two hosts minimum, on two segments.** App server and database server must not be the same box and should not be on the same VLAN (A.8.22). If the app server is compromised, that boundary is the only thing between the attacker and the whole requisition history.

#### Naming, DNS and TLS
- Internal hostname only — e.g. `purchasing.massymotors.local`. A-record on **internal DNS**. **No public DNS record.**
- HTTPS only. Port 80 redirects to 443. HSTS on. TLS 1.2 minimum (A.5.14, A.8.24).
- Certificate from their **internal CA** (AD Certificate Services — they almost certainly have it, being a Microsoft shop), with root trust already distributed by GPO. If they don't run internal PKI, a public cert via DNS-01 challenge works without exposing the host.

#### Firewall rules — default deny, then only these

| Source | Destination | Port | Purpose |
|---|---|---|---|
| Workstation VLANs | App server | 443 | The application |
| App server | DB server | 5432 | Database — **from the app server IP only** |
| App server | `login.microsoftonline.com` | 443 out | Entra ID authentication |
| App server | Microsoft Graph *or* internal SMTP relay | 443 / 587 | Approval notification email |
| App server | Approved NTP source | 123 | Clock sync (A.8.17) |
| App server | Package registry / patch source | 443 out | Via proxy, or use an internal artifact mirror |
| Power BI gateway | DB server | 5432 | **Reporting schema only, read-only DB user** |
| Backup agent | App + DB servers | as required | Backups |
| Admin jump host | App + DB servers | 3389 / 22 | Administration — **no direct admin access from user VLANs** |
| **DB server** | **anything outbound** | — | **DENY.** The database has no business calling the internet. |
| Everything else | — | — | Deny and log |

The DB egress rule matters more than it looks: it is the control that turns a database compromise from an exfiltration event into a contained one.

#### Remote access — decide this deliberately
Default position: **none.** The app is reachable from the office only.

But be realistic — approvers are managers, and managers travel. If approvals stall for three days because the Finance Manager is off-site, people will route around the app and your logbook stops being complete. Same failure mode as emergency purchases (§9, Q9). So pick one **before** go-live:

1. **Their existing corporate VPN** — simplest, nothing new to build.
2. **Microsoft Entra Private Access / Application Proxy** — outbound-only connector inside the network, no inbound firewall hole, and you get Conditional Access on top (require MFA, require compliant device, restrict by country).

**Never** publish it to the internet with a port forward. If option 2 is chosen, Conditional Access policy is a required deliverable, not an afterthought.

#### Power BI — one compliance flag
The on-premises data gateway is well-behaved: it makes an **outbound** connection to the Power BI service, so it needs no inbound firewall rule.

But if they use **Power BI Service (cloud)**, requisition and budget data leaves the organisational boundary. That triggers A.5.23 (information security for use of cloud services) and may collide with data residency (§9, Q7). Two options — the client must choose:
- Accept it, assess the tenant region, and document it as a cloud service in `/docs/THIRD-PARTIES.md`; **or**
- Use **Power BI Report Server** on-premises, keeping data inside.

Either way the reporting views stay masked (A.8.11).

#### Environments (A.8.31)
Dev, test and prod on **separate subnets with separate credentials**. Test must have no network route to the production database — enforce it with a firewall rule, not with a policy document. Production secrets exist only in production.

#### Host hardening (A.8.9, A.8.2)
Minimal OS install; this box runs nothing else. Host firewall enabled in addition to the network firewall. Administrative access only from a jump host — never RDP/SSH direct from a user workstation. Service accounts are non-interactive with least privilege. Secrets (DB credentials, Entra client secret) live in Azure Key Vault or Windows DPAPI-protected config with restricted ACLs — never a plaintext `.env` in a shared folder, never in the repo.

Forward application, authentication and audit events to their SIEM if they have one, so the §8 alert conditions land somewhere a human reads.

#### If they'd rather host in Azure
Same principles, different primitives: App Service with **VNet integration and public access disabled**, Azure Database for PostgreSQL Flexible Server with a **private endpoint and no public endpoint**, Key Vault for secrets, access via Entra Private Access. The rule is unchanged — no public endpoint, private networking, default-deny.

#### The ask list for Massy IT
Hand them this. These are the only things you need from them, and lead time on items 4 and 5 is usually what delays go-live:

1. Two VMs (app, DB) on separate segments, plus a backup target
2. Internal DNS A-record
3. Firewall rules per the table above
4. **Entra ID app registration** with redirect URI and the required Graph permissions ← start this early
5. **Internal CA certificate** for the hostname
6. A service account for the app, and one for backups
7. Inclusion in the nightly backup schedule and the patch cycle
8. SIEM log onboarding
9. Approved NTP source
10. Decision on the remote access path (VPN vs Entra Private Access)

---

## 3. Roles

Roles are assigned per user **per cost centre**, not globally.

| Role | Can |
|---|---|
| **Requester** | Create/submit requisitions, upload invoices for own requisitions, view own history |
| **Approver** | Approve/deny requisitions routed to them; see budget position for that cost centre |
| **Accounting** | View all approved requisitions + invoices, mark as posted to CDK, export batches |
| **Budget Owner** | Maintain budgets for their cost centres (upload from Excel) |
| **DOA Administrator** | Upload/version the DOA matrix; **cannot approve requisitions** |
| **Auditor** | Read-only across everything including audit log; can export nothing containing PII |
| **System Admin** | User/role assignment, config. **Cannot approve, cannot edit budgets, cannot delete records** |

**Segregation of duties is enforced in code, not policy** (A.5.3):
- A requester can never approve their own requisition — even if the DOA routes it to them. The rule engine skips to the next level and flags it.
- Admins cannot approve or alter financial data.
- Nobody can edit the DOA and approve against it in the same version.
- Accounting cannot approve.

---

## 4. Data model (core tables)

```
users                 id, entra_object_id, email, display_name, job_title, status, created_at
roles_assignments     user_id, role, cost_centre_id, granted_by, granted_at, revoked_at
cost_centres          id, code, name, department (e.g. 'Leasing'), parent_id, active
budgets               id, cost_centre_id, period (FY/quarter), category_id, amount,
                      currency, source_file_id, version, approved_by, approved_at
categories            id, code, name, gl_account_code, cdk_account_ref
suppliers             id, name, cdk_vendor_ref, tax_id, status
                      -- NOTE: no bank details in MVP. See §8, A.5.34.

doa_matrix_versions   id, version_no, effective_from, effective_to, status
                      (draft|active|superseded), source_file_id, file_sha256,
                      uploaded_by, approved_by, approved_at
doa_rules             id, version_id, category_id, cost_centre_id (nullable = all),
                      min_amount, max_amount, currency, approval_sequence (JSONB:
                      ordered list of role/user/job_title), requires_quotes (int),
                      notes

requisitions          id, reference (MM-LEA-2026-0001), requester_id, cost_centre_id,
                      category_id, supplier_id, description, justification,
                      amount, currency, needed_by, status, doa_version_id,
                      doa_rule_snapshot (JSONB — frozen at submit time),
                      approval_reference (issued only on final approval),
                      created_at, submitted_at, closed_at

approval_steps        id, requisition_id, step_no, assigned_role, assigned_user_id,
                      delegate_of_user_id, decision (pending|approved|denied),
                      decision_reason, decided_at, budget_remaining_at_decision,
                      ip_address, user_agent

attachments           id, requisition_id, type (quote|invoice|other), filename,
                      content_type, size_bytes, sha256, storage_key, scan_status,
                      uploaded_by, uploaded_at, classification

invoices              id, requisition_id, attachment_id, invoice_no, invoice_date,
                      amount, currency, status (submitted|posted|rejected),
                      posted_by, posted_at, cdk_reference, variance_vs_approved

audit_log             id, seq (bigserial), occurred_at (UTC), actor_user_id,
                      action, entity_type, entity_id, before (JSONB), after (JSONB),
                      ip_address, user_agent, prev_hash, row_hash
                      -- APPEND ONLY. See §8, A.8.15 / A.5.33.
```

### Two design rules that must not be broken

1. **Freeze the rule at submit time.** `doa_rule_snapshot` stores the exact rule that applied when the requisition was submitted. When the DOA changes next quarter, historical requisitions must still show the rule they were judged under. An auditor will ask this.
2. **Budget is committed, then actualised.** On final approval, the amount is **committed** against the budget (it reduces available budget immediately). On invoice posting, it becomes **actual**. `Available = Budget − Committed − Actual`. Show approvers the projected remaining balance *before* they click approve.

---

## 5. MVP feature set

### 5.1 Requisition form
Fields: cost centre, category, supplier, description, justification, amount, currency, needed-by date, quote attachments.
- Live display, as they type: *"This requires approval from: Dept Manager → Finance Manager"* — resolved from the live DOA.
- Live display: *"Available budget in this cost centre: $X. After this request: $Y."*
- Save as draft; validation on submit.
- If the DOA rule sets `requires_quotes = 3`, submission is blocked without 3 quote attachments.

### 5.2 Approval routing
- Sequential by default: step 2 does not open until step 1 approves.
- Any denial ends the chain immediately; requisition status → `Denied`; requester notified with the reason (reason is **mandatory** on denial).
- Delegation: an approver can nominate a delegate for a date range. The delegate's decision records both identities (`delegate_of_user_id`).
- SLA: configurable reminder at N days, escalation flag at M days. Escalation **notifies**, it does not auto-approve. Never auto-approve anything.
- Self-approval blocked (see §3).

### 5.3 Approval Reference issuance
On final approval, generate `MM-LEA-2026-0001-APR`. Requester sees "You may now contact the supplier." Include it on the printable/exportable approval certificate (PDF) the requester can send to the supplier.

### 5.4 Invoice submission
- Requester uploads the supplier invoice against the requisition. Cannot upload against a denied or pending requisition.
- Capture invoice number, date, amount. App flags variance vs approved amount; variance beyond a configurable tolerance (e.g. 5%) requires re-approval by the final approver.

### 5.5 Accounting queue
- List of invoices awaiting posting to CDK, with the approval trail visible and the invoice file viewable inline.
- "Mark as posted" — captures CDK reference + who posted + when.
- Batch export to Excel for keying into CDK (see §6).

### 5.6 The logbook
One filterable, exportable table of every requisition ever raised. Columns: reference, date, requester, cost centre, category, supplier, amount, status, each approver + decision + timestamp, invoice status, CDK reference. Saved filters. Export to Excel.

### 5.7 Dashboard (deliberately thin)
Four tiles: Pending my approval · My open requisitions · Budget position by cost centre · Denied this month. Anything more analytical belongs in Power BI (§6.3).

### 5.8 Admin
- User ↔ role ↔ cost centre assignment (with an access review export, see §8 A.5.18).
- DOA matrix upload + activation (§6.1).
- Budget upload (§6.2).
- Category / cost centre / supplier maintenance.

---

## 6. Integrations

### 6.1 Excel — the DOA matrix
The client lives in Excel. Don't fight it; make Excel the *input format* and the database the *system of record*.

- Provide a downloadable `.xlsx` template: one row per rule — Category, Cost Centre, Min Amount, Max Amount, Currency, Approver 1, Approver 2, Approver 3, Quotes Required, Notes.
- Upload → parse → **validate and show a diff against the current active version** → DOA Administrator submits → a second person (Finance Director role) **approves activation**. Two-person rule.
- Store the file, its SHA-256, and who uploaded/approved. Versions are never deleted, only superseded.
- Validation must catch: overlapping amount bands, gaps between bands, unknown approver names, currency mismatch, missing categories.

### 6.2 Excel — budgets
Same pattern: template per cost centre and period, upload, validate, diff, approve, version. Budget changes are audit-logged with before/after.

### 6.3 Excel — exports
Every list view gets **Export to Excel** (real `.xlsx` via ExcelJS, formatted, with a header block showing who exported it, when, and the filter applied).

Two purpose-built exports:
- **Accounting batch export** — the columns Accounting needs to key into CDK, in their order, ready to go.
- **Audit export** — full approval trail for a date range, for internal audit.

> ⚠️ **Every export is a data leakage event.** Log every export (who, what filter, how many rows) in `audit_log`. Stamp the file with a classification label. See §8, A.8.12 / A.5.13.

### 6.4 Power BI
Yes, it's relevant — and it's how you keep the app simple. Don't build analytics into the app; expose the data properly.

- Create a **read-only reporting schema** in Postgres with purpose-built views:
  `v_requisition_facts`, `v_budget_position`, `v_approval_cycle_time`, `v_denial_reasons`, `v_maverick_spend`.
- Create a **dedicated read-only database user** for Power BI with `SELECT` on the reporting schema only — no access to base tables, no access to `audit_log` detail.
- Connect Power BI via the **on-premises data gateway** with scheduled refresh.
- **Views must mask PII** — expose job titles and employee IDs, not personal contact details (A.8.11).

This gives Finance their dashboards without a single extra screen in the app.

### 6.5 CDK — MVP approach: reference fields + export, no API
CDK is their DMS and system of record for the ledger. Do **not** attempt a live integration in the MVP. Reasons: integration scope is unknown, it introduces a supplier-security assessment obligation (A.5.19–A.5.23), and it will sink the timeline.

**MVP:** capture CDK-shaped reference data (`cdk_vendor_ref`, `gl_account_code`, `cdk_reference` on invoice) and hand Accounting a clean Excel batch export in CDK's expected column layout. Accounting keys it in as they do today — but now every line has an approval behind it.

**Before Phase 2, someone must confirm with Massy IT:**
- Which CDK product and edition (the DMS product line, hosting model, region)?
- Is an API integration platform licensed for them, or is the available path ODBC / scheduled flat-file export?
- Who owns the CDK vendor relationship, and what does the contract permit?

Write these into `/docs/ASSUMPTIONS.md`. Phase 2 designs the integration once those answers exist.

---

## 7. Build phases

| Phase | Scope | Rough effort |
|---|---|---|
| **0 — Foundation** | Repo, CI, Postgres schema + migrations, Entra ID SSO, RBAC, audit log with hash chain, secrets management, dev/test/prod separation | 1 sprint |
| **1 — Core loop** | Requisition CRUD, DOA rule engine + Excel import, sequential approval, denial with reason, Approval Reference, email notifications | 2 sprints |
| **2 — Money & files** | Budgets (Excel import), committed/actual tracking, budget shown at approval, attachments with virus scan, invoice submission | 1–2 sprints |
| **3 — Accounting & reporting** | Accounting queue, mark-posted, Excel exports, logbook views, thin dashboard, Power BI reporting schema | 1 sprint |
| **4 — Hardening** | Security testing, pen test, backup/restore drill, access review export, runbooks, DR test, UAT with Leasing | 1 sprint |
| **5 — Pilot** | Leasing department live, 4 weeks parallel run alongside current process | — |

**Do not skip Phase 4.** An approvals system that fails an audit is worse than no system, because it created a record the client relied on.

---

## 8. ISO 27001 COMPLIANCE GATES — NORMATIVE

> **First, an honest framing.** ISO/IEC 27001:2022 certifies an *organisation's* Information Security Management System, not a piece of software. Clauses 4–10 (context, leadership, planning, support, operation, performance evaluation, improvement) are obligations on **Massy**, not on this app.
>
> What this app can and must do: implement the **Annex A controls** that fall to it, and produce the **evidence** Massy's ISMS needs. Build it so that when Massy is audited, this app is an asset in the evidence pack, not a finding.
>
> All control IDs, names, and quoted requirements below are taken verbatim from the client's copy of **ISO/IEC 27001:2022, Annex A, Table A.1**. Annex A is derived from ISO/IEC 27002:2022 Clauses 5–8 and uses identical numbering, so ISO 27002 guidance can be looked up by the same ID.

### 8.1 Controls the app must implement

| Control | Name (per Annex A) | What the app must do | Acceptance test |
|---|---|---|---|
| **A.5.3** | Segregation of duties | Requester ≠ approver, enforced in the rule engine. Admin cannot approve or edit budgets. DOA editor cannot approve against their own version. | Attempt self-approval via API directly → 403 and an audit entry. |
| **A.5.10** | Acceptable use of information and other associated assets | Login banner stating the system is monitored and for authorised business use. Acknowledged on first login, recorded. | Fresh user must acknowledge before reaching any data. |
| **A.5.12** | Classification of information | Every requisition, invoice, and export carries a classification (default `Internal`; invoices `Confidential`). | Schema has the field; exports carry it. |
| **A.5.13** | Labelling of information | Excel and PDF exports carry the classification in the header/footer, plus exporter identity and timestamp. | Open any export → label visible on page 1. |
| **A.5.14** | Information transfer | TLS 1.2+ everywhere. Email notifications contain deep links, **never** amounts, supplier names, or attachments. | Inspect a notification email → no financial data in the body. |
| **A.5.15** | Access control | RBAC, scoped per cost centre, default-deny. Enforce on the **server**, on every request. | Call another cost centre's requisition by ID → 404/403, never data. |
| **A.5.16** | Identity management | Identities come from Entra ID. No orphan local accounts except one documented break-glass. | Disable a test user in Entra → next request rejected. |
| **A.5.17** | Authentication information | No password storage in the app. Break-glass account: MFA-enforced, credentials in the client's vault, use alerts. | Grep the codebase → zero password hashing logic outside break-glass. |
| **A.5.18** | Access rights | Role grants record who granted, when, and why. Revocation is immediate. Quarterly **access review export**: every user, role, cost centre, last login. | Generate the review export; revoke a role → active session loses access within one request. |
| **A.5.19–5.23** | Supplier relationships / ICT supply chain / cloud services | Maintain `/docs/THIRD-PARTIES.md`: every hosting provider, library with a security-relevant role, and CDK. Note data location and what data each touches. | Document exists and is complete before go-live. |
| **A.5.28** | Collection of evidence | Audit log is exportable in a defensible, tamper-evident form suitable for investigation or dispute. | Export an approval trail → shows full chain with hashes. |
| **A.5.31** | Legal, statutory, regulatory and contractual requirements | Confirm the applicable data protection law for the operating country with the client's legal team and record retention obligations. | `/docs/ASSUMPTIONS.md` records the answer, not a guess. |
| **A.5.33** | Protection of records | Requisitions, approvals, denials, and invoices are **never hard-deleted**. Cancellation is a status, not a delete. No `DELETE` grant on financial tables for the app's DB role. | Attempt delete via API and via app DB user → both fail. |
| **A.5.34** | Privacy and protection of PII | Collect the minimum: name, work email, job title, cost centre. **No supplier bank details in MVP** — they belong in CDK, and holding them here creates fraud risk with no benefit. | Schema review: no bank/payment fields exist. |
| **A.5.37** | Documented operating procedures | Ship runbooks: backup/restore, DOA version rollback, access provisioning, incident response for this app. | `/docs/runbooks/` populated before go-live. |
| **A.8.2** | Privileged access rights | Admin actions are separately logged and alertable. Admin role grants no read access to financial detail it doesn't need. | Admin account cannot approve or view invoice amounts. |
| **A.8.3** | Information access restriction | Consider Postgres Row-Level Security as defence-in-depth behind application authorisation. | Direct DB query as app user honours cost-centre scope. |
| **A.8.5** | Secure authentication | OIDC authorization code flow + PKCE. Session timeout (30 min idle / 8 hr absolute). MFA inherited from Entra conditional access. | Idle 31 minutes → re-authentication required. |
| **A.8.7** | Protection against malware | **Every uploaded file is virus-scanned before it is retrievable.** Allowlist `pdf/jpg/png/xlsx` by magic bytes, not extension. Size cap. Never serve from a path the web server executes. | Upload EICAR test file → quarantined, uploader notified, event logged. |
| **A.8.8** | Management of technical vulnerabilities | Dependency scanning in CI (`npm audit` / Dependabot / Snyk). Build fails on High/Critical. Documented patch SLA. | Introduce a known-vulnerable dependency → CI fails. |
| **A.8.9** | Configuration management | All config via environment variables. **Zero secrets in the repo.** Infrastructure and config changes tracked in version control. | Secret scanner in CI passes on a clean history. |
| **A.8.11** | Data masking | Power BI reporting views expose job titles and IDs, not personal contact details. | Query every reporting view → no personal email/phone. |
| **A.8.12** | Data leakage prevention | Every Excel/PDF export logged: who, when, filter, row count. Rate-limit bulk exports. Alert on abnormal volume. | Export 3 reports → 3 audit entries with row counts. |
| **A.8.13** | Information backup | Nightly encrypted Postgres backup + attachment storage backup. **Restore tested before go-live and quarterly thereafter**, with the result documented. | A dated, signed restore test record exists. |
| **A.8.15** | Logging | Append-only `audit_log`: every create, submit, approve, deny, budget change, DOA activation, role change, export, login, failed login. Records actor, UTC timestamp, before/after, IP, user agent. **Hash-chained** (`row_hash = SHA256(prev_hash ‖ row_contents)`). No `UPDATE`/`DELETE` grant to the app role — enforce with a DB trigger too. | Attempt to alter a historical audit row → rejected; chain verification job detects any tampering. |
| **A.8.16** | Monitoring activities | Alert on: repeated failed logins, privilege escalation, bulk export, out-of-hours admin activity, audit chain verification failure. | Trigger each condition in test → alert fires. |
| **A.8.17** | Clock synchronization | Server clock synced to an approved NTP source. **All timestamps stored in UTC**, rendered in local time. | Every timestamp column is `timestamptz`; no naive local times. |
| **A.8.20** | Networks security | Internal-only deployment per §2. No public DNS record, no inbound perimeter rule. Default-deny firewall; only the rules in §2 permitted. | External port scan of the perimeter finds nothing; internal scan finds 443 only. |
| **A.8.21** | Security of network services | Every permitted flow documented with source, destination, port and purpose (§2 firewall table). Outbound from the app server is allowlisted; the DB server has **no** outbound internet route. | Attempt an outbound connection from the DB host → blocked and logged. |
| **A.8.22** | Segregation of networks | App server and DB server on separate VLANs. Admin access only via jump host. Dev/test have no route to the production database. | From a test-environment host, attempt to reach the prod DB → connection refused at the firewall. |
| **A.8.24** | Use of cryptography | TLS 1.2+ in transit. Encryption at rest for DB and attachments. Document algorithms and key management. | TLS scan passes; `/docs/CRYPTO.md` exists. |
| **A.8.25** | Secure development life cycle | Documented SDLC: branch protection, mandatory peer review, no direct commits to `main`. | Attempt a direct push to `main` → blocked. |
| **A.8.26** | Application security requirements | This Section 8 **is** the security requirements specification. Traceability matrix: requirement → implementation → test. | `/docs/CONTROL-MATRIX.md` maps every row above to code and a test. |
| **A.8.28** | Secure coding | Parameterised queries only. Server-side validation on every input (Zod). Output encoding. CSP, HSTS, X-Frame-Options, X-Content-Type-Options. CSRF protection. | OWASP ASVS L1 checklist passed; automated SAST clean. |
| **A.8.29** | Security testing in development and acceptance | Automated security tests in CI. Independent penetration test before go-live. Findings closed or formally risk-accepted. | Pen test report + remediation evidence. |
| **A.8.31** | Separation of development, test and production environments | Three environments, separate credentials, separate databases. | No shared credentials across environments. |
| **A.8.32** | Change management | All schema changes via versioned migrations. Releases tagged, changelogged, with rollback steps. | `git log` + migration history reconstruct any prior state. |
| **A.8.33** | Test information | **Never copy production data into test.** Use generated synthetic data. | Seed script generates fake data; no prod dump path exists. |

### 8.2 Controls that are Massy's, not the app's — but the app supports

Note these to the client; don't build them:

- **A.5.1 / A.5.2 / A.5.4** — Policies, roles and responsibilities, management responsibilities. The DOA itself is a management artefact; the app enforces it.
- **A.6.3** — Information security awareness, education and training. Users need training on the new process; the app's acceptable-use banner supports it but doesn't replace it.
- **A.6.8 / A.5.24–5.27** — Event reporting and incident management. Point users at Massy's existing incident channel.
- **A.7.x** — All physical controls. Applies to wherever the server lives.
- **A.5.29 / A.5.30** — Information security during disruption / ICT readiness for business continuity. Define RTO and RPO with the client before Phase 4; the backup design in A.8.13 must meet them.
- **A.5.35 / A.5.36** — Independent review and compliance monitoring. The audit exports feed these.

### 8.3 Compliance definition of done

A feature is not done until:
1. It has a test.
2. Every applicable row in §8.1 has been checked against it.
3. `/docs/CONTROL-MATRIX.md` is updated with the control → code → test mapping.
4. If a control could not be satisfied, it is recorded as an exception with a reason and an owner — **not silently skipped**.

---

## 9. Open questions for the client

Answer these before Phase 1 ends. Record answers in `/docs/ASSUMPTIONS.md`.

1. **DOA content** — thresholds, approver roles, and escalation paths. The app is data-driven, but a realistic draft is needed for testing.
2. **Currency** — single base currency, or multi-currency with FX? Which base?
3. **Budget structure** — annual or quarterly? By cost centre only, or cost centre × category? Do unspent amounts carry forward?
4. **Approval routing** — always sequential, or is any level parallel? Can an approver approve at a *lower* level than the DOA requires (downward delegation)?
5. **CDK** — product, edition, hosting model, and whether API/ODBC access is licensed and contractually permitted.
6. **Retention** — how long must requisitions and invoices be kept? Driven by tax law and Massy Group policy (A.5.31).
7. **Jurisdiction & data protection law** — which country's law governs, and does data have to stay in-country? This decides on-prem vs Azure region.
8. **Entra ID** — will IT grant an app registration and the required Graph permissions? Confirm early; it's a common blocker.
9. **Emergency purchases** — is there a break-glass path for urgent buys (e.g. a vehicle recovery at 11pm)? If yes: retrospective approval within 24 hours, flagged permanently in the log, reported monthly. Design it deliberately or people will route around the app.
10. **Existing PO numbering** — does Massy already have a PO series the Approval Reference should align with?
11. **Remote access** — can approvers act from outside the office? If yes, via the existing VPN or Entra Private Access (§2)? This must be settled before go-live, not after approvers start complaining.
12. **Power BI hosting** — Power BI Service (cloud, data leaves the boundary → A.5.23) or Power BI Report Server (on-premises)? Ties to Q7.

---

## 10. Kickoff prompt for the build

> Build Phase 0 of the Massy Motors Purchase Approval app as specified in `Massy-Motors-Purchase-Approval-App-Dev-Plan.md`.
>
> Scope: repo scaffold, CI pipeline with dependency and secret scanning, PostgreSQL schema and migrations for all tables in §4, Entra ID OIDC authentication with PKCE, RBAC middleware enforcing cost-centre scoping server-side, the append-only hash-chained audit log with a DB-level trigger blocking UPDATE and DELETE, environment separation, and `/docs/CONTROL-MATRIX.md` seeded with every control from §8.1.
>
> Before you finish, verify your work against §8 and report which controls are satisfied, which are deferred to later phases, and which need a client decision.

---

*Standards referenced: ISO/IEC 27001:2022 (Third edition, 2022-10), Annex A Table A.1 — controls quoted verbatim from the client-supplied copy. ISO/IEC 27002:2022 provides implementation guidance under identical control numbering.*
