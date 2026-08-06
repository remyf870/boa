// Budget governance & live tracker (plan §5.9, §6.2).
// No budget figure is ever set by direct edit: a Budget Owner proposes a
// versioned budget (Excel upload or in-app lines) with a mandatory reason,
// submits it, and a Budget Approver — never the proposer (two-person rule,
// DB-enforced) — approves or rejects it in-app. Activation supersedes the
// previous version atomically. The live position streams to open screens over
// SSE and is recomputed from base records on every read.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { canAccessCostCentre, hasRole, requireAuth } from '../plugins/rbac.js';
import { budgetPosition, currentPeriod } from '../budgets/position.js';
import { readSetting } from '../settings.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';
import { eventBus } from '../events/bus.js';
import { detectFileKind } from '../files/magic.js';
import { scanBuffer } from '../files/scanner.js';
import { saveAttachmentFile, sha256Hex } from '../files/storage.js';

// Quarterly only: fiscal_period_of() always resolves to a quarter label, so an
// annual period could never match a requisition — the budget would be invisible
// to the tracker while commitments accrued (adversarial-review finding). The DB
// CHECK (0010) agrees. Annual budgets, if the client wants them (plan §9 Q3),
// need fiscal_period_of, this pattern and the CHECK changed together.
const PERIOD_RE = /^FY\d{4}-Q[1-4]$/;

const lineSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.coerce.number().min(0).multipleOf(0.01),
});

function canSeeBudgets(user: import('../auth/sessions.js').CurrentUser, costCentreId: string): boolean {
  return (
    canAccessCostCentre(user, costCentreId) ||
    hasRole(user, 'requester', costCentreId) ||
    hasRole(user, 'budget_owner', costCentreId) ||
    hasRole(user, 'budget_approver')
  );
}

export default async function budgetRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  // ── Template (per cost centre and period, plan §6.2) ───────────────────────
  app.get(
    '/api/budgets/template.xlsx',
    { preHandler: requireAuth(), config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const user = req.currentUser!;
      const query = z
        .object({ costCentreId: z.string().uuid(), period: z.string().regex(PERIOD_RE) })
        .safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
      if (!hasRole(user, 'budget_owner', query.data.costCentreId)) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      const base = await readSetting(db, 'base_currency');
      const data = await withUserContext(db, user.id, async (client) => {
        const cc = await client.query<{ code: string }>('SELECT code FROM cost_centres WHERE id = $1', [
          query.data.costCentreId,
        ]);
        const categories = await client.query<{ id: string; code: string; name: string }>(
          'SELECT id, code, name FROM categories WHERE active ORDER BY code',
        );
        const active = await client.query<{ category_id: string; amount: string }>(
          `SELECT b.category_id, b.amount
           FROM budgets b
           JOIN budget_versions bv ON bv.id = b.version_id
           WHERE bv.cost_centre_id = $1 AND bv.period = $2 AND bv.status = 'active'`,
          [query.data.costCentreId, query.data.period],
        );
        return { code: cc.rows[0]?.code, categories: categories.rows, active: active.rows };
      });
      if (!data.code) return reply.code(404).send({ error: 'not_found' });

      const activeByCat = new Map(data.active.map((a) => [a.category_id, Number(a.amount)]));
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Budget');
      ws.addRow(['Classification: Internal']);
      ws.addRow([`Cost centre: ${data.code}`]);
      ws.addRow([`Period: ${query.data.period}`]);
      ws.addRow([`Exported by: ${user.displayName} <${user.email}>`]);
      ws.addRow([`Exported at (UTC): ${new Date().toISOString()}`]);
      ws.addRow([]);
      const header = ws.addRow(['Category', 'Amount', 'Currency']);
      header.font = { bold: true };
      for (const c of data.categories) {
        ws.addRow([c.code, activeByCat.get(c.id) ?? 0, base]);
      }
      [24, 16, 10].forEach((w, i) => (ws.getColumn(i + 1).width = w));
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      return reply
        .header('content-disposition', `attachment; filename="budget-${data.code}-${query.data.period}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buffer);
    },
  );

  // ── Propose: Excel upload → validated draft version (budget_owner) ─────────
  app.post(
    '/api/budgets/upload',
    { preHandler: requireAuth(), config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const user = req.currentUser!;
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file_required' });
      const meta = z
        .object({
          costCentreId: z.string().uuid(),
          period: z.string().regex(PERIOD_RE),
          reason: z.string().min(3).max(2000),
        })
        .safeParse({
          costCentreId: (file.fields['costCentreId'] as { value?: unknown } | undefined)?.value,
          period: (file.fields['period'] as { value?: unknown } | undefined)?.value,
          reason: (file.fields['reason'] as { value?: unknown } | undefined)?.value,
        });
      if (!meta.success) {
        return reply.code(400).send({ error: 'invalid_request', message: meta.error.issues[0]?.message });
      }
      if (!hasRole(user, 'budget_owner', meta.data.costCentreId)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const buffer = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'file_too_large' });
      const maxBytes = await readSetting(db, 'attachment_max_bytes');
      if (buffer.length === 0 || buffer.length > maxBytes) {
        return reply.code(413).send({ error: 'file_too_large', maxBytes });
      }
      const detected = detectFileKind(buffer);
      if (!detected || detected.kind !== 'xlsx') return reply.code(415).send({ error: 'not_an_xlsx_file' });
      const verdict = await scanBuffer(config, buffer);
      if (verdict.status === 'infected') {
        await writeAudit(db, {
          actorUserId: user.id,
          action: AuditAction.AttachmentQuarantined,
          entityType: 'attachment',
          after: { filename: file.filename, signature: verdict.signature, context: 'budget_upload' },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return reply.code(422).send({ error: 'file_failed_virus_scan' });
      }

      // Parse: Category | Amount | Currency
      const base = await readSetting(db, 'base_currency');
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      } catch {
        return reply.code(422).send({ error: 'validation_failed', issues: ['File is not a readable .xlsx workbook'] });
      }
      const ws = wb.worksheets[0];
      const issues: string[] = [];
      const parsed: { rowNo: number; categoryCode: string; amount: number; currency: string }[] = [];
      let headerRowNo = 0;
      ws?.eachRow((row, rowNo) => {
        const c1 = String(row.getCell(1).value ?? '').trim();
        if (headerRowNo === 0 && c1.toLowerCase() === 'category') {
          headerRowNo = rowNo;
          return;
        }
        if (headerRowNo === 0 || rowNo <= headerRowNo || !c1) return;
        const amountRaw = String(row.getCell(2).value ?? '').replace(/[, ]/g, '');
        const amount = Number(amountRaw);
        const currency = String(row.getCell(3).value ?? '').trim().toUpperCase();
        if (!Number.isFinite(amount) || amount < 0) issues.push(`Row ${rowNo}: Amount must be a number >= 0`);
        if (currency !== base) issues.push(`Row ${rowNo}: currency ${currency || '(blank)'} must be ${base}`);
        parsed.push({ rowNo, categoryCode: c1.toUpperCase(), amount, currency });
      });
      if (headerRowNo === 0) issues.push('Header row not found — use the downloadable template');
      if (parsed.length === 0) issues.push('The workbook contains no budget lines');
      const seen = new Set<string>();
      for (const p of parsed) {
        if (seen.has(p.categoryCode)) issues.push(`Row ${p.rowNo}: category ${p.categoryCode} appears twice`);
        seen.add(p.categoryCode);
      }
      if (issues.length > 0) return reply.code(422).send({ error: 'validation_failed', issues });

      const outcome = await withUserContext(db, user.id, async (client) => {
        const categories = await client.query<{ id: string; code: string }>(
          'SELECT id, code FROM categories WHERE active',
        );
        const byCode = new Map(categories.rows.map((c) => [c.code.toUpperCase(), c.id]));
        const lines: { categoryId: string; amount: number }[] = [];
        const semanticIssues: string[] = [];
        for (const p of parsed) {
          const id = byCode.get(p.categoryCode);
          if (!id) semanticIssues.push(`Row ${p.rowNo}: unknown category "${p.categoryCode}"`);
          else lines.push({ categoryId: id, amount: p.amount });
        }
        if (semanticIssues.length > 0) return { code: 422 as const, issues: semanticIssues };

        const { storageKey } = await saveAttachmentFile(config, buffer, { quarantined: false });
        const sha = sha256Hex(buffer);
        const attachment = await client.query<{ id: string }>(
          `INSERT INTO attachments (type, filename, content_type, size_bytes, sha256, storage_key,
                                    scan_status, uploaded_by, classification)
           VALUES ('budget_import', $1, $2, $3, $4, $5, 'clean', $6, 'internal') RETURNING id`,
          [file.filename, detected.contentType, buffer.length, sha, storageKey, user.id],
        );
        const created = await createDraftVersion(client, {
          costCentreId: meta.data.costCentreId,
          period: meta.data.period,
          reason: meta.data.reason,
          proposedBy: user.id,
          sourceFileId: attachment.rows[0]!.id,
          fileSha256: sha,
          lines,
        });
        await writeAudit(client, {
          actorUserId: user.id,
          action: AuditAction.BudgetVersionCreated,
          entityType: 'budget_version',
          entityId: created.versionId,
          after: {
            costCentreId: meta.data.costCentreId,
            period: meta.data.period,
            versionNo: created.versionNo,
            reason: meta.data.reason,
            lineCount: lines.length,
            source: 'excel_upload',
            fileSha256: sha,
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { code: 201 as const, ...created };
      });

      if (outcome.code === 422) return reply.code(422).send({ error: 'validation_failed', issues: outcome.issues });
      return reply.code(201).send({ ok: true, versionId: outcome.versionId, versionNo: outcome.versionNo });
    },
  );

  // ── Propose: in-app lines (budget_owner) ───────────────────────────────────
  app.post('/api/budgets/versions', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const body = z
      .object({
        costCentreId: z.string().uuid(),
        period: z.string().regex(PERIOD_RE),
        reason: z.string().min(3).max(2000),
        lines: z.array(lineSchema).min(1).max(200),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message });
    }
    if (!hasRole(user, 'budget_owner', body.data.costCentreId)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const distinct = new Set(body.data.lines.map((l) => l.categoryId));
    if (distinct.size !== body.data.lines.length) {
      return reply.code(400).send({ error: 'duplicate_category_lines' });
    }

    const created = await withUserContext(db, user.id, async (client) => {
      const result = await createDraftVersion(client, {
        costCentreId: body.data.costCentreId,
        period: body.data.period,
        reason: body.data.reason,
        proposedBy: user.id,
        sourceFileId: null,
        fileSha256: null,
        lines: body.data.lines,
      });
      await writeAudit(client, {
        actorUserId: user.id,
        action: AuditAction.BudgetVersionCreated,
        entityType: 'budget_version',
        entityId: result.versionId,
        after: {
          costCentreId: body.data.costCentreId,
          period: body.data.period,
          versionNo: result.versionNo,
          reason: body.data.reason,
          lineCount: body.data.lines.length,
          source: 'in_app',
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return result;
    });
    return reply.code(201).send({ ok: true, versionId: created.versionId, versionNo: created.versionNo });
  });

  // ── Versions list + detail (line-by-line diff against active) ──────────────
  app.get('/api/budgets/versions', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const query = z.object({ costCentreId: z.string().uuid().optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    if (query.data.costCentreId && !canSeeBudgets(user, query.data.costCentreId)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(
        `SELECT bv.id, bv.cost_centre_id, cc.code AS cost_centre_code, bv.period, bv.version_no,
                bv.status, bv.reason, bv.created_at, bv.submitted_at, bv.approved_at, bv.rejected_at,
                bv.rejection_reason,
                pu.display_name AS proposed_by_name, au.display_name AS approved_by_name,
                ru.display_name AS rejected_by_name,
                (SELECT count(*) FROM budgets b WHERE b.version_id = bv.id) AS line_count,
                (SELECT coalesce(sum(b.amount), 0) FROM budgets b WHERE b.version_id = bv.id) AS total_amount
         FROM budget_versions bv
         JOIN cost_centres cc ON cc.id = bv.cost_centre_id
         JOIN users pu ON pu.id = bv.proposed_by
         LEFT JOIN users au ON au.id = bv.approved_by
         LEFT JOIN users ru ON ru.id = bv.rejected_by
         WHERE ($1::uuid IS NULL OR bv.cost_centre_id = $1)
         ORDER BY bv.created_at DESC
         LIMIT 200`,
        [query.data.costCentreId ?? null],
      );
      return result.rows;
    });
    return { versions: rows };
  });

  app.get('/api/budgets/versions/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const detail = await withUserContext(db, user.id, async (client) => {
      const version = await client.query<{ id: string; cost_centre_id: string; period: string; [k: string]: unknown }>(
        `SELECT bv.*, cc.code AS cost_centre_code,
                pu.display_name AS proposed_by_name, au.display_name AS approved_by_name,
                ru.display_name AS rejected_by_name
         FROM budget_versions bv
         JOIN cost_centres cc ON cc.id = bv.cost_centre_id
         JOIN users pu ON pu.id = bv.proposed_by
         LEFT JOIN users au ON au.id = bv.approved_by
         LEFT JOIN users ru ON ru.id = bv.rejected_by
         WHERE bv.id = $1`,
        [params.data.id],
      );
      const row = version.rows[0];
      if (!row) return null;
      const lines = await client.query(
        `SELECT b.category_id, cat.code AS category_code, cat.name AS category_name, b.amount, b.currency
         FROM budgets b JOIN categories cat ON cat.id = b.category_id
         WHERE b.version_id = $1 ORDER BY cat.code`,
        [row.id],
      );
      // Diff against the currently ACTIVE version for the same scope
      const activeLines = await client.query<{ category_id: string; category_code: string; amount: string }>(
        `SELECT b.category_id, cat.code AS category_code, b.amount
         FROM budgets b
         JOIN budget_versions bv ON bv.id = b.version_id
         JOIN categories cat ON cat.id = b.category_id
         WHERE bv.cost_centre_id = $1 AND bv.period = $2 AND bv.status = 'active' AND bv.id <> $3`,
        [row.cost_centre_id, row.period, row.id],
      );
      const activeByCat = new Map(activeLines.rows.map((l) => [l.category_id, l]));
      const diff = (lines.rows as { category_id: string; category_code: string; amount: string }[]).map((l) => {
        const before = activeByCat.get(l.category_id);
        activeByCat.delete(l.category_id);
        return {
          categoryCode: l.category_code,
          before: before ? before.amount : null,
          after: l.amount,
          change: !before ? 'added' : Number(before.amount) !== Number(l.amount) ? 'changed' : 'unchanged',
        };
      });
      for (const gone of activeByCat.values()) {
        diff.push({ categoryCode: gone.category_code, before: gone.amount, after: null as unknown as string, change: 'removed' });
      }
      return { version: row, lines: lines.rows, diff };
    });

    if (!detail) return reply.code(404).send({ error: 'not_found' });
    const v = detail.version;
    if (!canSeeBudgets(user, v.cost_centre_id)) return reply.code(404).send({ error: 'not_found' });
    return detail;
  });

  // ── Submit for approval (proposer) ─────────────────────────────────────────
  app.post('/api/budgets/versions/:id/submit', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const outcome = await withUserContext(db, user.id, async (client) => {
      const found = await client.query<{
        id: string;
        status: string;
        proposed_by: string;
        cost_centre_id: string;
        period: string;
        version_no: number;
        cost_centre_code: string;
      }>(
        `SELECT bv.id, bv.status, bv.proposed_by, bv.cost_centre_id, bv.period, bv.version_no,
                cc.code AS cost_centre_code
         FROM budget_versions bv JOIN cost_centres cc ON cc.id = bv.cost_centre_id
         WHERE bv.id = $1 FOR UPDATE OF bv`,
        [params.data.id],
      );
      const version = found.rows[0];
      if (!version || version.proposed_by !== user.id) return { code: 404 as const };
      if (version.status !== 'draft') return { code: 409 as const, error: 'only_drafts_can_be_submitted' };
      const lineCount = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM budgets WHERE version_id = $1',
        [version.id],
      );
      if (Number(lineCount.rows[0]!.n) === 0) return { code: 422 as const, error: 'version_has_no_lines' };

      await client.query(
        `UPDATE budget_versions SET status = 'pending_approval', submitted_at = now() WHERE id = $1`,
        [version.id],
      );
      // Notify every budget approver (who the role maps to is TODO(client) Q13)
      const approvers = await client.query<{ user_id: string }>(
        `SELECT DISTINCT ra.user_id FROM roles_assignments ra
         JOIN users u ON u.id = ra.user_id AND u.status = 'active'
         WHERE ra.role = 'budget_approver' AND ra.revoked_at IS NULL AND ra.user_id <> $1`,
        [user.id],
      );
      const label = `${version.cost_centre_code} ${version.period} v${version.version_no}`;
      for (const a of approvers.rows) {
        await queueNotification(client, {
          recipientUserId: a.user_id,
          template: NotificationTemplate.BudgetSubmitted,
          reference: label,
          deepLink: `/budgets/versions/${version.id}`,
        });
      }
      await writeAudit(client, {
        actorUserId: user.id,
        action: AuditAction.BudgetVersionSubmitted,
        entityType: 'budget_version',
        entityId: version.id,
        after: { label, notifiedApprovers: approvers.rows.length },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { code: 200 as const };
    });

    if (outcome.code !== 200) {
      return reply.code(outcome.code).send({ error: 'error' in outcome ? outcome.error : 'not_found' });
    }
    return { ok: true };
  });

  // ── Approve / reject (budget_approver — never the proposer) ────────────────
  const decideBudget = (kind: 'approve' | 'reject') =>
    async function handler(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
      const user = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = z.object({ reason: z.string().min(3).max(2000).optional() }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      if (kind === 'reject' && !body.data.reason) return reply.code(400).send({ error: 'rejection_reason_required' });
      if (!hasRole(user, 'budget_approver')) return reply.code(403).send({ error: 'forbidden' });

      const outcome = await withUserContext(db, user.id, async (client) => {
        const found = await client.query<{
          id: string;
          status: string;
          proposed_by: string;
          cost_centre_id: string;
          period: string;
          version_no: number;
          cost_centre_code: string;
          reason: string;
        }>(
          `SELECT bv.id, bv.status, bv.proposed_by, bv.cost_centre_id, bv.period, bv.version_no,
                  bv.reason, cc.code AS cost_centre_code
           FROM budget_versions bv JOIN cost_centres cc ON cc.id = bv.cost_centre_id
           WHERE bv.id = $1 FOR UPDATE OF bv`,
          [params.data.id],
        );
        const version = found.rows[0];
        if (!version) return { code: 404 as const, error: 'not_found' };
        if (version.status !== 'pending_approval') return { code: 409 as const, error: 'not_pending_approval' };
        // Two-person rule (plan §5.9) — also a DB CHECK; refuse loudly here
        if (version.proposed_by === user.id) {
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.BudgetApprovalRefused,
            entityType: 'budget_version',
            entityId: version.id,
            after: { reason: 'two_person_rule — proposer cannot approve own budget' },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 403 as const, error: 'proposer_cannot_approve' };
        }

        const label = `${version.cost_centre_code} ${version.period} v${version.version_no}`;
        if (kind === 'reject') {
          await client.query(
            `UPDATE budget_versions
             SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = $3
             WHERE id = $1`,
            [version.id, user.id, body.data.reason],
          );
          await queueNotification(client, {
            recipientUserId: version.proposed_by,
            template: NotificationTemplate.BudgetRejected,
            reference: label,
            deepLink: `/budgets/versions/${version.id}`,
          });
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.BudgetVersionRejected,
            entityType: 'budget_version',
            entityId: version.id,
            after: { label, reason: body.data.reason },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 200 as const, costCentreId: null };
        }

        // Approve: supersede the current active version for this scope, then
        // activate — with before/after amounts in the audit entry (plan §6.2).
        // Serialised per scope so two concurrent approvals cannot both pass
        // the supersede scan and collide on budget_versions_one_active_uq.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `budget_activation:${version.cost_centre_id}:${version.period}`,
        ]);
        const previous = await client.query<{ id: string; version_no: number }>(
          `UPDATE budget_versions SET status = 'superseded'
           WHERE cost_centre_id = $1 AND period = $2 AND status = 'active'
           RETURNING id, version_no`,
          [version.cost_centre_id, version.period],
        );
        await client.query(
          `UPDATE budget_versions SET status = 'active', approved_by = $2, approved_at = now() WHERE id = $1`,
          [version.id, user.id],
        );
        const beforeLines = previous.rows[0]
          ? (
              await client.query<{ code: string; amount: string }>(
                `SELECT cat.code, b.amount FROM budgets b JOIN categories cat ON cat.id = b.category_id
                 WHERE b.version_id = $1 ORDER BY cat.code`,
                [previous.rows[0].id],
              )
            ).rows
          : [];
        const afterLines = (
          await client.query<{ code: string; amount: string }>(
            `SELECT cat.code, b.amount FROM budgets b JOIN categories cat ON cat.id = b.category_id
             WHERE b.version_id = $1 ORDER BY cat.code`,
            [version.id],
          )
        ).rows;
        await queueNotification(client, {
          recipientUserId: version.proposed_by,
          template: NotificationTemplate.BudgetApproved,
          reference: label,
          deepLink: `/budgets/versions/${version.id}`,
        });
        await writeAudit(client, {
          actorUserId: user.id,
          action: AuditAction.BudgetVersionApproved,
          entityType: 'budget_version',
          entityId: version.id,
          before: { versionNo: previous.rows[0]?.version_no ?? null, lines: beforeLines },
          after: { label, versionNo: version.version_no, lines: afterLines, changeReason: version.reason },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { code: 200 as const, costCentreId: version.cost_centre_id };
      });

      if (outcome.code !== 200) return reply.code(outcome.code).send({ error: outcome.error });
      if (outcome.costCentreId) {
        eventBus.emitBudgetChanged({ costCentreId: outcome.costCentreId, cause: 'budget_version_activated' });
      }
      return reply.send({ ok: true });
    };

  app.post('/api/budgets/versions/:id/approve', { preHandler: requireAuth() }, decideBudget('approve'));
  app.post('/api/budgets/versions/:id/reject', { preHandler: requireAuth() }, decideBudget('reject'));

  // ── Live tracker stream (plan §5.9) — SSE, cookie-authenticated ────────────
  app.get('/api/budgets/stream', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const query = z.object({ costCentreId: z.string().uuid() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const costCentreId = query.data.costCentreId;
    if (!canSeeBudgets(user, costCentreId)) return reply.code(404).send({ error: 'not_found' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const send = async () => {
      try {
        const position = await withUserContext(db, user.id, async (client) => {
          const period = await currentPeriod(client);
          return budgetPosition(client, costCentreId, period);
        });
        reply.raw.write(`event: position\ndata: ${JSON.stringify(position)}\n\n`);
      } catch {
        // connection raced a shutdown — the close handler cleans up
      }
    };
    await send();

    const unsubscribe = eventBus.onBudgetChanged((event) => {
      if (event.costCentreId === costCentreId) void send();
    });
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    // Keep the connection open — Fastify must not try to send a response
    return reply;
  });
}

async function createDraftVersion(
  client: import('pg').PoolClient,
  params: {
    costCentreId: string;
    period: string;
    reason: string;
    proposedBy: string;
    sourceFileId: string | null;
    fileSha256: string | null;
    lines: { categoryId: string; amount: number }[];
  },
): Promise<{ versionId: string; versionNo: number }> {
  const base = await readSetting(client, 'base_currency');
  // Serialise numbering per (cost centre, period): concurrent proposals for
  // the same scope would otherwise read the same max and collide on the
  // UNIQUE (cost_centre_id, period, version_no) (adversarial-review finding).
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `budget_version_no:${params.costCentreId}:${params.period}`,
  ]);
  const nextNo = await client.query<{ n: number }>(
    `SELECT coalesce(max(version_no), 0) + 1 AS n FROM budget_versions WHERE cost_centre_id = $1 AND period = $2`,
    [params.costCentreId, params.period],
  );
  const version = await client.query<{ id: string; version_no: number }>(
    `INSERT INTO budget_versions (cost_centre_id, period, version_no, reason, source_file_id, file_sha256, proposed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, version_no`,
    [
      params.costCentreId,
      params.period,
      nextNo.rows[0]!.n,
      params.reason,
      params.sourceFileId,
      params.fileSha256,
      params.proposedBy,
    ],
  );
  for (const line of params.lines) {
    await client.query(
      `INSERT INTO budgets (cost_centre_id, category_id, period, amount, currency, version, version_id, source_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.costCentreId,
        line.categoryId,
        params.period,
        line.amount,
        base,
        version.rows[0]!.version_no,
        version.rows[0]!.id,
        params.sourceFileId,
      ],
    );
  }
  return { versionId: version.rows[0]!.id, versionNo: version.rows[0]!.version_no };
}
