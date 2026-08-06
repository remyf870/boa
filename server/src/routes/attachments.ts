// Attachment upload/download (plan §5.1 quotes, A.8.7).
// Upload: magic-byte allowlist → size cap → synchronous virus scan → store.
// An infected file lands in quarantine, is never retrievable, and raises an
// alert + notification. Download: clean files only, forced attachment
// disposition, from a private directory the web server never serves.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, raiseAlert, writeAudit } from '../audit/audit.js';
import { canAccessCostCentre, requireAuth } from '../plugins/rbac.js';
import { detectFileKind } from '../files/magic.js';
import { scanBuffer } from '../files/scanner.js';
import { openCleanFile, saveAttachmentFile, sha256Hex } from '../files/storage.js';
import { readSetting } from '../settings.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';

export default async function attachmentRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  // ── Upload a quote/other against my own requisition ────────────────────────
  app.post(
    '/api/requisitions/:id/attachments',
    { preHandler: requireAuth(), config: { rateLimit: { max: 60, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const user = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });

      // Authorisation FIRST: a user with no relationship to the requisition
      // must not be able to make the server buffer a large body at all
      // (adversarial-review finding).
      const requisition = await withUserContext(db, user.id, async (client) => {
        const { rows } = await client.query<{ id: string; requester_id: string; status: string; reference: string }>(
          'SELECT id, requester_id, status, reference FROM requisitions WHERE id = $1',
          [params.data.id],
        );
        return rows[0] ?? null;
      });
      if (!requisition || requisition.requester_id !== user.id) return reply.code(404).send({ error: 'not_found' });
      if (['denied', 'closed', 'cancelled'].includes(requisition.status)) {
        return reply.code(409).send({ error: 'requisition_terminal' });
      }

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file_required' });
      const typeField = (file.fields['type'] as { value?: string } | undefined)?.value ?? 'quote';
      const type = z.enum(['quote', 'other']).safeParse(typeField);
      if (!type.success) return reply.code(400).send({ error: 'invalid_attachment_type' });
      if (type.data === 'quote' && requisition.status !== 'draft') {
        // Quotes are part of what the approvers judge — frozen at submission
        return reply.code(409).send({ error: 'quotes_only_on_drafts' });
      }
      const buffer = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'file_too_large' });

      const maxBytes = await readSetting(db, 'attachment_max_bytes');
      if (buffer.length === 0 || buffer.length > maxBytes) {
        return reply.code(413).send({ error: 'file_too_large', maxBytes });
      }
      const detected = detectFileKind(buffer);
      if (!detected) {
        return reply.code(415).send({ error: 'file_type_not_allowed', allowed: ['pdf', 'jpg', 'png', 'xlsx'] });
      }

      // A.8.7: scanned BEFORE it becomes retrievable — synchronously, here.
      const verdict = await scanBuffer(config, buffer);
      const sha = sha256Hex(buffer);
      const { storageKey } = await saveAttachmentFile(config, buffer, {
        quarantined: verdict.status === 'infected',
      });

      const attachmentId = await withUserContext(db, user.id, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO attachments (requisition_id, type, filename, content_type, size_bytes, sha256,
                                    storage_key, scan_status, uploaded_by, classification)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'internal')
           RETURNING id`,
          [
            requisition.id,
            type.data,
            file.filename,
            detected.contentType,
            buffer.length,
            sha,
            storageKey,
            verdict.status === 'infected' ? 'infected' : 'clean',
            user.id,
          ],
        );
        const id = inserted.rows[0]!.id;
        if (verdict.status === 'infected') {
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.AttachmentQuarantined,
            entityType: 'attachment',
            entityId: id,
            after: { filename: file.filename, signature: verdict.signature, requisitionId: requisition.id },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          await raiseAlert(client, 'malware_upload_quarantined', 'critical', {
            attachmentId: id,
            uploaderUserId: user.id,
            signature: verdict.signature,
          });
          await queueNotification(client, {
            recipientUserId: user.id,
            template: NotificationTemplate.AttachmentQuarantined,
            reference: requisition.reference,
            deepLink: `/requisitions/${requisition.id}`,
          });
        } else {
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.AttachmentUploaded,
            entityType: 'attachment',
            entityId: id,
            after: { filename: file.filename, type: type.data, sizeBytes: buffer.length, sha256: sha },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
        }
        return id;
      });

      if (verdict.status === 'infected') {
        return reply.code(422).send({ error: 'file_failed_virus_scan', attachmentId });
      }
      return reply.code(201).send({ ok: true, attachmentId });
    },
  );

  // ── Download — clean files only, scoped like the requisition (A.5.15) ──────
  app.get('/api/attachments/:id/download', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const row = await withUserContext(db, user.id, async (client) => {
      const { rows } = await client.query<{
        id: string;
        requisition_id: string | null;
        filename: string;
        content_type: string;
        storage_key: string;
        scan_status: string;
        uploaded_by: string;
        requester_id: string | null;
        cost_centre_id: string | null;
      }>(
        `SELECT a.id, a.requisition_id, a.filename, a.content_type, a.storage_key, a.scan_status,
                a.uploaded_by, r.requester_id, r.cost_centre_id
         FROM attachments a
         LEFT JOIN requisitions r ON r.id = a.requisition_id
         WHERE a.id = $1`,
        [params.data.id],
      );
      return rows[0] ?? null;
    });

    const allowed =
      row &&
      (row.uploaded_by === user.id ||
        (row.requester_id !== null && row.requester_id === user.id) ||
        (row.cost_centre_id !== null && canAccessCostCentre(user, row.cost_centre_id)));
    if (!row || !allowed) return reply.code(404).send({ error: 'not_found' });
    // A.8.7: an unscanned or infected file does not exist for download purposes
    if (row.scan_status !== 'clean') return reply.code(409).send({ error: 'file_not_available' });

    await writeAudit(db, {
      actorUserId: user.id,
      action: AuditAction.AttachmentDownloaded,
      entityType: 'attachment',
      entityId: row.id,
      after: { filename: row.filename },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    const safeName = row.filename.replace(/[^\w.\- ]/g, '_');
    return reply
      .header('content-disposition', `attachment; filename="${safeName}"`)
      .header('x-content-type-options', 'nosniff')
      .type(row.content_type)
      .send(openCleanFile(config, row.storage_key));
  });
}
