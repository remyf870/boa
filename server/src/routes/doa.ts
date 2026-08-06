// DOA matrix administration (plan §6.1). Excel in, database as system of
// record. Upload (doa_admin) → validate + diff → draft version; activation by
// a DIFFERENT person holding doa_approver (two-person rule — enforced by the
// 0002 CHECK, the SoD role trigger, and again here). Versions are never
// deleted, only superseded (A.5.33).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { requireAuth, requireRoles } from '../plugins/rbac.js';
import { DOA_TEMPLATE_COLUMNS, diffAgainstActive, parseDoaWorkbook, validateDoaRules } from '../doa/import.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';
import { readSetting } from '../settings.js';
import { detectFileKind } from '../files/magic.js';
import { scanBuffer } from '../files/scanner.js';
import { saveAttachmentFile, sha256Hex } from '../files/storage.js';

export default async function doaRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  // ── Template download, prefilled with the active matrix (plan §6.1) ────────
  app.get(
    '/api/doa/template.xlsx',
    { preHandler: requireRoles(db, 'doa_admin', 'doa_approver', 'auditor') },
    async (req, reply) => {
      const actor = req.currentUser!;
      const { rows } = await db.query<{
        category_code: string;
        cost_centre_code: string | null;
        min_amount: string;
        max_amount: string | null;
        currency: string;
        approval_sequence: { type: string; value: string }[];
        requires_quotes: number;
        notes: string | null;
      }>(
        `SELECT cat.code AS category_code, cc.code AS cost_centre_code,
                dr.min_amount, dr.max_amount, dr.currency, dr.approval_sequence,
                dr.requires_quotes, dr.notes
         FROM doa_rules dr
         JOIN doa_matrix_versions dv ON dv.id = dr.version_id AND dv.status = 'active'
         JOIN categories cat ON cat.id = dr.category_id
         LEFT JOIN cost_centres cc ON cc.id = dr.cost_centre_id
         ORDER BY cat.code, cc.code NULLS FIRST, dr.min_amount`,
      );

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('DOA Matrix');
      ws.addRow(['Classification: Internal']);
      ws.addRow([`Exported by: ${actor.displayName} <${actor.email}>`]);
      ws.addRow([`Exported at (UTC): ${new Date().toISOString()}`]);
      ws.addRow([
        'Approver cells: "job_title:Finance Manager", "user:name@domain", or "role:approver". ' +
          'A bare value is read as a job title.',
      ]);
      ws.addRow([]);
      const header = ws.addRow([...DOA_TEMPLATE_COLUMNS]);
      header.font = { bold: true };
      for (const r of rows) {
        // Always emit the explicit "type:value" form so the export re-imports
        // as exactly the same descriptors. Writing job titles bare made
        // round-tripping lossy for titles containing '@' or a "role:"-like
        // prefix (adversarial-review finding).
        const approvers = r.approval_sequence.map((a) => `${a.type}:${a.value}`);
        ws.addRow([
          r.category_code,
          r.cost_centre_code ?? '',
          Number(r.min_amount),
          r.max_amount === null ? '' : Number(r.max_amount),
          r.currency,
          approvers[0] ?? '',
          approvers[1] ?? '',
          approvers[2] ?? '',
          r.requires_quotes,
          r.notes ?? '',
        ]);
      }
      DOA_TEMPLATE_COLUMNS.forEach((_, i) => (ws.getColumn(i + 1).width = 20));
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.Export,
        entityType: 'export',
        entityId: 'doa-template',
        after: { rowCount: rows.length, format: 'xlsx' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply
        .header('content-disposition', 'attachment; filename="doa-matrix-template.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buffer);
    },
  );

  // ── Versions listing ───────────────────────────────────────────────────────
  app.get('/api/doa/versions', { preHandler: requireAuth() }, async (req) => {
    const user = req.currentUser!;
    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(
        `SELECT dv.id, dv.version_no, dv.status, dv.effective_from, dv.effective_to,
                dv.uploaded_at, dv.approved_at, dv.file_sha256,
                up.display_name AS uploaded_by_name, ap.display_name AS approved_by_name,
                (SELECT count(*) FROM doa_rules dr WHERE dr.version_id = dv.id) AS rule_count
         FROM doa_matrix_versions dv
         JOIN users up ON up.id = dv.uploaded_by
         LEFT JOIN users ap ON ap.id = dv.approved_by
         ORDER BY dv.version_no DESC`,
      );
      return result.rows;
    });
    return { versions: rows };
  });

  app.get('/api/doa/versions/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const detail = await withUserContext(db, user.id, async (client) => {
      const version = await client.query(
        `SELECT dv.*, up.display_name AS uploaded_by_name, ap.display_name AS approved_by_name
         FROM doa_matrix_versions dv
         JOIN users up ON up.id = dv.uploaded_by
         LEFT JOIN users ap ON ap.id = dv.approved_by
         WHERE dv.id = $1`,
        [params.data.id],
      );
      if (version.rows.length === 0) return null;
      const rules = await client.query(
        `SELECT dr.id, cat.code AS category_code, cc.code AS cost_centre_code,
                dr.min_amount, dr.max_amount, dr.currency, dr.approval_sequence,
                dr.requires_quotes, dr.notes
         FROM doa_rules dr
         JOIN categories cat ON cat.id = dr.category_id
         LEFT JOIN cost_centres cc ON cc.id = dr.cost_centre_id
         WHERE dr.version_id = $1
         ORDER BY cat.code, cc.code NULLS FIRST, dr.min_amount`,
        [params.data.id],
      );
      return { version: version.rows[0], rules: rules.rows };
    });
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return detail;
  });

  // ── Upload → validate → diff → draft version (doa_admin) ───────────────────
  app.post(
    '/api/doa/upload',
    { preHandler: requireRoles(db, 'doa_admin'), config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const actor = req.currentUser!;
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file_required' });
      const buffer = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'file_too_large' });

      const maxBytes = await readSetting(db, 'attachment_max_bytes');
      if (buffer.length === 0 || buffer.length > maxBytes) {
        return reply.code(413).send({ error: 'file_too_large', maxBytes });
      }
      const detected = detectFileKind(buffer);
      if (!detected || detected.kind !== 'xlsx') {
        return reply.code(415).send({ error: 'not_an_xlsx_file' });
      }
      // A.8.7: scanned before anything else happens to it
      const verdict = await scanBuffer(config, buffer);
      if (verdict.status === 'infected') {
        await writeAudit(db, {
          actorUserId: actor.id,
          action: AuditAction.AttachmentQuarantined,
          entityType: 'attachment',
          after: { filename: file.filename, signature: verdict.signature, context: 'doa_upload' },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return reply.code(422).send({ error: 'file_failed_virus_scan' });
      }

      const parsed = await parseDoaWorkbook(buffer);
      if (parsed.errors.length > 0) {
        return reply.code(422).send({ error: 'validation_failed', issues: parsed.errors });
      }
      const base = await readSetting(db, 'base_currency');

      const outcome = await withUserContext(db, actor.id, async (client) => {
        const validation = await validateDoaRules(client, parsed.rules, base);
        if (validation.errors.length > 0) {
          return { code: 422 as const, issues: validation.errors };
        }
        const diff = await diffAgainstActive(client, validation.rules);

        const { storageKey } = await saveAttachmentFile(config, buffer, { quarantined: false });
        const sha = sha256Hex(buffer);
        const attachment = await client.query<{ id: string }>(
          `INSERT INTO attachments (type, filename, content_type, size_bytes, sha256, storage_key,
                                    scan_status, uploaded_by, classification)
           VALUES ('doa_matrix', $1, $2, $3, $4, $5, 'clean', $6, 'internal')
           RETURNING id`,
          [file.filename, detected.contentType, buffer.length, sha, storageKey, actor.id],
        );

        // Serialise version numbering: two concurrent uploads would otherwise
        // read the same max and collide on the UNIQUE version_no.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['doa_version_no']);
        const nextNo = await client.query<{ n: number }>(
          'SELECT coalesce(max(version_no), 0) + 1 AS n FROM doa_matrix_versions',
        );
        // Warnings persist ON the version so the activator — a different
        // person by rule — reviews the same routing holes the uploader was
        // shown (§6.1; previously they lived only in the uploader's browser).
        const version = await client.query<{ id: string; version_no: number }>(
          `INSERT INTO doa_matrix_versions (version_no, status, source_file_id, file_sha256, uploaded_by,
                                            validation_warnings)
           VALUES ($1, 'draft', $2, $3, $4, $5) RETURNING id, version_no`,
          [nextNo.rows[0]!.n, attachment.rows[0]!.id, sha, actor.id, JSON.stringify(validation.warnings)],
        );
        for (const r of validation.rules) {
          await client.query(
            `INSERT INTO doa_rules (version_id, category_id, cost_centre_id, min_amount, max_amount,
                                    currency, approval_sequence, requires_quotes, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              version.rows[0]!.id,
              r.categoryId,
              r.costCentreId,
              r.minAmount,
              r.maxAmount,
              r.currency,
              JSON.stringify(r.approvers),
              r.requiresQuotes,
              r.notes,
            ],
          );
        }
        // A draft nobody is told about keeps every new requisition routing on
        // the stale matrix — tell every activator there is work waiting
        // (mirrors budget submission; §5.2 outbox rules: reference only).
        const activators = await client.query<{ user_id: string }>(
          `SELECT DISTINCT ra.user_id FROM roles_assignments ra
           JOIN users u ON u.id = ra.user_id AND u.status = 'active'
           WHERE ra.role = 'doa_approver' AND ra.revoked_at IS NULL AND ra.user_id <> $1`,
          [actor.id],
        );
        for (const a of activators.rows) {
          await queueNotification(client, {
            recipientUserId: a.user_id,
            template: NotificationTemplate.DoaSubmitted,
            reference: `v${version.rows[0]!.version_no}`,
            deepLink: '/admin',
          });
        }
        await writeAudit(client, {
          actorUserId: actor.id,
          action: AuditAction.DoaVersionUploaded,
          entityType: 'doa_matrix_version',
          entityId: version.rows[0]!.id,
          after: {
            versionNo: version.rows[0]!.version_no,
            fileSha256: sha,
            ruleCount: validation.rules.length,
            notifiedActivators: activators.rows.length,
            diffSummary: {
              added: diff.entries.filter((e) => e.change === 'added').length,
              removed: diff.entries.filter((e) => e.change === 'removed').length,
              changed: diff.entries.filter((e) => e.change === 'changed').length,
            },
            // Routing holes the reviewer must see before activating (§6.1)
            warnings: validation.warnings,
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return {
          code: 201 as const,
          versionId: version.rows[0]!.id,
          versionNo: version.rows[0]!.version_no,
          diff,
          warnings: validation.warnings,
        };
      });

      if (outcome.code === 422) return reply.code(422).send({ error: 'validation_failed', issues: outcome.issues });
      return reply.code(201).send({
        ok: true,
        versionId: outcome.versionId,
        versionNo: outcome.versionNo,
        diff: outcome.diff,
        warnings: outcome.warnings,
        message: 'Draft created. A doa_approver (not the uploader) must activate it.',
      });
    },
  );

  // ── Diff of a draft against the active version (for the review screen) ─────
  app.get(
    '/api/doa/versions/:id/diff',
    { preHandler: requireRoles(db, 'doa_admin', 'doa_approver', 'auditor') },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const actor = req.currentUser!;
      const diff = await withUserContext(db, actor.id, async (client) => {
        const rules = await client.query<{
          category_code: string;
          cost_centre_code: string | null;
          category_id: string;
          cost_centre_id: string | null;
          min_amount: string;
          max_amount: string | null;
          currency: string;
          approval_sequence: { type: 'job_title' | 'user' | 'role'; value: string }[];
          requires_quotes: number;
          notes: string | null;
        }>(
          `SELECT cat.code AS category_code, cc.code AS cost_centre_code,
                  dr.category_id, dr.cost_centre_id, dr.min_amount, dr.max_amount,
                  dr.currency, dr.approval_sequence, dr.requires_quotes, dr.notes
           FROM doa_rules dr
           JOIN categories cat ON cat.id = dr.category_id
           LEFT JOIN cost_centres cc ON cc.id = dr.cost_centre_id
           WHERE dr.version_id = $1`,
          [params.data.id],
        );
        if (rules.rows.length === 0) return null;
        return diffAgainstActive(
          client,
          rules.rows.map((r, i) => ({
            rowNo: i + 1,
            categoryCode: r.category_code.toUpperCase(),
            costCentreCode: r.cost_centre_code?.toUpperCase() ?? null,
            categoryId: r.category_id,
            costCentreId: r.cost_centre_id,
            minAmount: Number(r.min_amount),
            maxAmount: r.max_amount === null ? null : Number(r.max_amount),
            currency: r.currency,
            approvers: r.approval_sequence,
            requiresQuotes: r.requires_quotes,
            notes: r.notes,
          })),
        );
      });
      if (!diff) return reply.code(404).send({ error: 'not_found' });
      return diff;
    },
  );

  // ── Activation — the second person (doa_approver), never the uploader ──────
  app.post(
    '/api/doa/versions/:id/activate',
    { preHandler: requireRoles(db, 'doa_approver') },
    async (req, reply) => {
      const actor = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });

      const outcome = await withUserContext(db, actor.id, async (client) => {
        const found = await client.query<{ id: string; version_no: number; status: string; uploaded_by: string }>(
          'SELECT id, version_no, status, uploaded_by FROM doa_matrix_versions WHERE id = $1 FOR UPDATE',
          [params.data.id],
        );
        const version = found.rows[0];
        if (!version) return { code: 404 as const, error: 'not_found' };
        if (version.status !== 'draft') return { code: 409 as const, error: 'only_drafts_can_be_activated' };
        if (version.uploaded_by === actor.id) {
          await writeAudit(client, {
            actorUserId: actor.id,
            action: AuditAction.DoaActivationRefused,
            entityType: 'doa_matrix_version',
            entityId: version.id,
            after: { reason: 'two_person_rule — uploader cannot activate' },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 403 as const, error: 'uploader_cannot_activate' };
        }

        // Revalidate at activation: categories, cost centres, users and role
        // grants can all change between upload and activation, and every §6.1
        // guarantee was made against the state at upload time
        // (adversarial-review finding).
        const draftRules = await client.query<{
          category_code: string;
          cost_centre_code: string | null;
          min_amount: string;
          max_amount: string | null;
          currency: string;
          approval_sequence: { type: 'job_title' | 'user' | 'role'; value: string }[];
          requires_quotes: number;
          notes: string | null;
        }>(
          `SELECT cat.code AS category_code, cc.code AS cost_centre_code, dr.min_amount, dr.max_amount,
                  dr.currency, dr.approval_sequence, dr.requires_quotes, dr.notes
           FROM doa_rules dr
           JOIN categories cat ON cat.id = dr.category_id
           LEFT JOIN cost_centres cc ON cc.id = dr.cost_centre_id
           WHERE dr.version_id = $1`,
          [version.id],
        );
        const revalidation = await validateDoaRules(
          client,
          draftRules.rows.map((r, i) => ({
            rowNo: i + 1,
            categoryCode: r.category_code.toUpperCase(),
            costCentreCode: r.cost_centre_code?.toUpperCase() ?? null,
            minAmount: Number(r.min_amount),
            maxAmount: r.max_amount === null ? null : Number(r.max_amount),
            currency: r.currency,
            approvers: r.approval_sequence,
            requiresQuotes: r.requires_quotes,
            notes: r.notes,
          })),
          await readSetting(client, 'base_currency'),
        );
        if (revalidation.errors.length > 0) {
          await writeAudit(client, {
            actorUserId: actor.id,
            action: AuditAction.DoaActivationRefused,
            entityType: 'doa_matrix_version',
            entityId: version.id,
            after: { reason: 'revalidation_failed', issues: revalidation.errors.slice(0, 20) },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 422 as const, error: 'revalidation_failed', issues: revalidation.errors };
        }

        // Serialise activation for the whole matrix: two concurrent
        // activations would otherwise both pass the "supersede the active
        // one" scan and collide on doa_matrix_one_active_uq.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['doa_activation']);
        const previous = await client.query<{ id: string; version_no: number }>(
          `UPDATE doa_matrix_versions SET status = 'superseded', effective_to = now()
           WHERE status = 'active' RETURNING id, version_no`,
        );
        await client.query(
          `UPDATE doa_matrix_versions
           SET status = 'active', effective_from = now(), approved_by = $2, approved_at = now()
           WHERE id = $1`,
          [version.id, actor.id],
        );
        // Close the loop with the uploader — they cannot see activation
        // happen and were previously never told their version went live.
        await queueNotification(client, {
          recipientUserId: version.uploaded_by,
          template: NotificationTemplate.DoaActivated,
          reference: `v${version.version_no}`,
          deepLink: '/admin',
        });
        await writeAudit(client, {
          actorUserId: actor.id,
          action: AuditAction.DoaVersionActivated,
          entityType: 'doa_matrix_version',
          entityId: version.id,
          before: { activeVersionNo: previous.rows[0]?.version_no ?? null },
          after: {
            versionNo: version.version_no,
            supersededVersionId: previous.rows[0]?.id ?? null,
            revalidationWarnings: revalidation.warnings,
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { code: 200 as const, versionNo: version.version_no };
      });

      if (outcome.code !== 200) {
        return reply
          .code(outcome.code)
          .send({ error: outcome.error, ...('issues' in outcome ? { issues: outcome.issues } : {}) });
      }
      return { ok: true, versionNo: outcome.versionNo };
    },
  );
}
