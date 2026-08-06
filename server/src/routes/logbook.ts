// The logbook (plan §5.6): one filterable, exportable table of every
// requisition ever raised — visibility scoped by role (requesters: own;
// approvers: their cost centres; accounting/auditor: all). Saved filters are
// personal. Every export is labelled, logged and rate-limited (A.5.13/A.8.12).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { requireAuth } from '../plugins/rbac.js';
import { buildLabelledWorkbook } from '../exports/excel.js';

const filterSchema = z.object({
  status: z.enum(['draft', 'submitted', 'approved', 'denied', 'closed', 'cancelled']).optional(),
  costCentreId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
type LogbookFilter = z.infer<typeof filterSchema>;

const LOGBOOK_SQL = `
  SELECT r.id, r.reference, r.created_at, r.submitted_at, r.approved_at, r.closed_at,
         r.status, r.amount, r.currency, r.description, r.approval_reference,
         r.classification,
         cc.code AS cost_centre_code, cat.code AS category_code,
         u.display_name AS requester_name, s.name AS supplier_name,
         (SELECT json_agg(json_build_object(
            'stepNo', st.step_no, 'approverName', au.display_name,
            'decision', st.decision, 'decidedAt', st.decided_at,
            'delegateOf', du.display_name, 'purpose', st.purpose
          ) ORDER BY st.step_no)
          FROM approval_steps st
          LEFT JOIN users au ON au.id = st.assigned_user_id
          LEFT JOIN users du ON du.id = st.delegate_of_user_id
          WHERE st.requisition_id = r.id) AS approval_trail,
         (SELECT json_agg(json_build_object(
            'invoiceNo', i.invoice_no, 'status', i.status, 'amount', i.amount,
            'cdkReference', i.cdk_reference, 'postedAt', i.posted_at))
          FROM invoices i WHERE i.requisition_id = r.id) AS invoices
  FROM requisitions r
  JOIN cost_centres cc ON cc.id = r.cost_centre_id
  JOIN categories cat ON cat.id = r.category_id
  JOIN users u ON u.id = r.requester_id
  LEFT JOIN suppliers s ON s.id = r.supplier_id
  WHERE (r.requester_id = $1 OR app_user_can_read_cost_centre(r.cost_centre_id))
    AND ($2::requisition_status IS NULL OR r.status = $2)
    AND ($3::uuid IS NULL OR r.cost_centre_id = $3)
    AND ($4::uuid IS NULL OR r.category_id = $4)
    AND ($5::uuid IS NULL OR r.supplier_id = $5)
    AND ($6::timestamptz IS NULL OR r.created_at >= $6)
    AND ($7::timestamptz IS NULL OR r.created_at < $7)
    AND ($8::text IS NULL OR r.reference ILIKE '%' || $8 || '%' OR r.description ILIKE '%' || $8 || '%')
  ORDER BY r.created_at DESC
  LIMIT $9`;

function filterParams(userId: string, f: LogbookFilter): unknown[] {
  return [
    userId,
    f.status ?? null,
    f.costCentreId ?? null,
    f.categoryId ?? null,
    f.supplierId ?? null,
    f.from ?? null,
    f.to ?? null,
    f.search ?? null,
    f.limit,
  ];
}

export default async function logbookRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db } = opts;

  app.get('/api/logbook', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const filter = filterSchema.safeParse(req.query);
    if (!filter.success) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(LOGBOOK_SQL, filterParams(user.id, filter.data));
      return result.rows;
    });
    return { entries: rows };
  });

  app.get(
    '/api/logbook/export.xlsx',
    { preHandler: requireAuth(), config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const user = req.currentUser!;
      const filter = filterSchema.safeParse(req.query);
      if (!filter.success) return reply.code(400).send({ error: 'invalid_request' });
      const rows = await withUserContext(db, user.id, async (client) => {
        const result = await client.query(LOGBOOK_SQL, filterParams(user.id, filter.data));
        return result.rows as Record<string, unknown>[];
      });

      const describeTrail = (trail: unknown): string =>
        Array.isArray(trail)
          ? trail
              .map(
                (s: { stepNo: number; approverName?: string; decision: string; decidedAt?: string; delegateOf?: string }) =>
                  `${s.stepNo}. ${s.approverName ?? '?'}${s.delegateOf ? ` (for ${s.delegateOf})` : ''}: ${s.decision}${
                    s.decidedAt ? ` @ ${s.decidedAt}` : ''
                  }`,
              )
              .join('; ')
          : '';
      const describeInvoices = (inv: unknown): string =>
        Array.isArray(inv)
          ? inv
              .map(
                (i: { invoiceNo: string; status: string; cdkReference?: string }) =>
                  `${i.invoiceNo}: ${i.status}${i.cdkReference ? ` (CDK ${i.cdkReference})` : ''}`,
              )
              .join('; ')
          : '';

      const filterDescription = JSON.stringify({ ...filter.data, from: filter.data.from?.toISOString(), to: filter.data.to?.toISOString() });
      const buffer = await buildLabelledWorkbook({
        title: 'Requisition logbook',
        classification: 'Internal',
        exportedBy: `${user.displayName} <${user.email}>`,
        filterDescription,
        columns: [
          { header: 'Reference', key: 'reference', width: 20 },
          { header: 'Created (UTC)', key: 'created_at', width: 22 },
          { header: 'Requester', key: 'requester_name', width: 24 },
          { header: 'Cost centre', key: 'cost_centre_code', width: 12 },
          { header: 'Category', key: 'category_code', width: 14 },
          { header: 'Supplier', key: 'supplier_name', width: 26 },
          { header: 'Amount', key: 'amount', width: 14 },
          { header: 'Currency', key: 'currency', width: 9 },
          { header: 'Status', key: 'status', width: 12 },
          { header: 'Approval trail', key: 'trail', width: 60 },
          { header: 'Approval reference', key: 'approval_reference', width: 22 },
          { header: 'Invoices', key: 'invoice_summary', width: 40 },
        ],
        rows: rows.map((r) => ({
          ...r,
          created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
          trail: describeTrail(r.approval_trail),
          invoice_summary: describeInvoices(r.invoices),
        })),
      });
      await writeAudit(db, {
        actorUserId: user.id,
        action: AuditAction.Export,
        entityType: 'export',
        entityId: 'logbook',
        after: { rowCount: rows.length, filter: filterDescription, format: 'xlsx' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply
        .header('content-disposition', 'attachment; filename="requisition-logbook.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buffer);
    },
  );

  // ── Saved filters (plan §5.6) — personal convenience data ─────────────────
  app.get('/api/saved-filters', { preHandler: requireAuth() }, async (req) => {
    const user = req.currentUser!;
    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(
        'SELECT id, view, name, filter, created_at FROM saved_filters WHERE user_id = $1 ORDER BY name',
        [user.id],
      );
      return result.rows;
    });
    return { filters: rows };
  });

  app.post('/api/saved-filters', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const body = z
      .object({
        view: z.string().min(1).max(50),
        name: z.string().min(1).max(100),
        filter: z.record(z.unknown()),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const id = await withUserContext(db, user.id, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO saved_filters (user_id, view, name, filter) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, view, name) DO UPDATE SET filter = EXCLUDED.filter
         RETURNING id`,
        [user.id, body.data.view, body.data.name, JSON.stringify(body.data.filter)],
      );
      return inserted.rows[0]!.id;
    });
    return reply.code(201).send({ ok: true, id });
  });

  app.delete('/api/saved-filters/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const deleted = await withUserContext(db, user.id, async (client) => {
      const result = await client.query('DELETE FROM saved_filters WHERE id = $1 AND user_id = $2', [
        params.data.id,
        user.id,
      ]);
      return result.rowCount ?? 0;
    });
    if (deleted === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
