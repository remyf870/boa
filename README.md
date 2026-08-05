# Massy Motors — Purchase Approval & DOA Enforcement App

A purchase requisition and approval logbook that enforces Massy Motors' Delegation of
Authority (DOA). Nobody buys anything until the app says they can, and every request —
approved or denied — leaves a permanent, tamper-evident record.

**The specification for this system is
[Massy-Motors-Purchase-Approval-App-Dev-Plan.md](Massy-Motors-Purchase-Approval-App-Dev-Plan.md).**
Section 8 of that document (ISO 27001 Compliance Gates) is normative: no feature is
complete until it passes the applicable gates and `/docs/CONTROL-MATRIX.md` is updated.

## Repository layout

| Path | Contents |
|---|---|
| `server/` | Fastify + TypeScript API, PostgreSQL migrations, audit log, RBAC, auth |
| `web/` | React 18 + TypeScript + Vite SPA (installed as a desktop app via Edge PWA) |
| `docs/` | ASSUMPTIONS, CONTROL-MATRIX, THIRD-PARTIES, CRYPTO, runbooks |
| `.github/workflows/` | CI: typecheck, lint, tests, dependency audit, secret scanning |

## Quick start (development)

Only prerequisite: **Node 20+**. You do not need PostgreSQL or Docker installed — the
`dev:db` script boots a bundled PostgreSQL for local development.

The server deliberately **refuses to start without configuration** (A.8.9: no silent
defaults), so run `dev:setup` first or you will get
`Invalid server configuration: DATABASE_URL: Required …`.

**Terminal 1 — database** (leave running):

```bash
cd server && npm install && npm run dev:setup && npm run dev:db
```

**Terminal 2 — API:**

```bash
cd server && npm run migrate && npm run seed && npm run dev
```

**Terminal 3 — web UI:**

```bash
cd web && npm install && npm run dev
```

Then open **http://localhost:5173**, click *Sign in with Microsoft*, and pick any synthetic
user from the development sign-in list.

What each script does:

| Script | Purpose |
|---|---|
| `npm run dev:setup` | Writes `server/.env` with freshly generated secrets. Gitignored; run once. |
| `npm run dev:db` | Starts a local PostgreSQL on port 5433 (data in `server/.pgdata-dev/`). |
| `npm run migrate` | Applies the SQL migrations. |
| `npm run seed` | Loads synthetic data — 11 fake users, DOA v1, budgets (A.8.33). |
| `npm run dev` | Starts the API on port 3001. |
| `npm test` | Full suite; boots its own throwaway database. |

Development auth (`AUTH_MODE=dev`) signs you in as a seeded synthetic user without an Entra
tenant. Config validation **refuses to start** with `AUTH_MODE=dev` when
`NODE_ENV=production` — production uses Microsoft Entra ID (OIDC + PKCE) only.

Useful synthetic logins (all `@example.test`, all fake):

| User | Roles |
|---|---|
| Riya Maharaj | Requester (Leasing) — has seeded requisitions |
| Devon Charles | Approver (Leasing) |
| Marcus Joseph | Accounting (org-wide) |
| Camille Baptiste | Auditor — the only role that can read the audit log |
| Andre Williams | System Admin — deliberately sees **no** financial records (A.8.2) |

### Troubleshooting

- **`Invalid server configuration: … Required`** — you skipped `npm run dev:setup`.
- **`ECONNREFUSED ::1:5433`** — the database terminal isn't running; start `npm run dev:db`.
- **`pre-existing shared memory block is still in use`** — a previous database process is
  still alive. Stop it, or delete `server/.pgdata-dev/` to start clean.

## Non-negotiable engineering rules

1. **No secrets in the repo.** Config comes from environment variables; CI runs a secret
   scanner over history. (A.8.9)
2. **All schema changes are versioned SQL migrations.** Never edit the database by hand.
   (A.8.32)
3. **Financial records are never hard-deleted.** Cancellation is a status. The database
   enforces this with triggers and withheld grants, not just application code. (A.5.33)
4. **The audit log is append-only and hash-chained.** Run `npm run verify-audit-chain`
   to prove integrity. (A.8.15)
5. **Anything "configurable" is data in the database**, not a constant in code. The DOA
   will change; a hardcoded threshold is a defect.
6. **Assumptions are written down.** If a decision was made without a client answer, it
   is in `docs/ASSUMPTIONS.md` with a `TODO(client)` marker.
