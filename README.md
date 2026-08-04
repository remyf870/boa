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

Prerequisites: Node 20+, PostgreSQL 16 (a local instance or a dev database URL).

```
# API
cd server
npm install
copy .env.example .env        # fill in local values — never commit .env
npm run migrate               # applies SQL migrations
npm run seed                  # synthetic data only (A.8.33 — never production data)
npm run dev

# Web
cd web
npm install
npm run dev
```

Development auth: set `AUTH_MODE=dev` in `server/.env` to sign in as a seeded synthetic
user without an Entra ID tenant. The server refuses to start with `AUTH_MODE=dev` when
`NODE_ENV=production`. Production uses Microsoft Entra ID (OIDC + PKCE) only.

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
