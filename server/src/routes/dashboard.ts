// Dashboard (plan §5.7 — deliberately thin): four tiles.
// Pending my approval · My open requisitions · Budget position by cost centre
// · Denied this month. Anything more analytical belongs in Power BI (§6.4).
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { requireAuth } from '../plugins/rbac.js';
import { budgetPosition, currentPeriod } from '../budgets/position.js';

export default async function dashboardRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db } = opts;

  app.get('/api/dashboard', { preHandler: requireAuth() }, async (req) => {
    const user = req.currentUser!;

    return withUserContext(db, user.id, async (client) => {
      // §5.9/§6.1 governance work waits in its own queues. Without these the
      // only way a budget or DOA approver learns something needs them is to
      // browse to the right page and pick the right cost centre.
      const [pendingBudgets, pendingDoa] = await Promise.all([
        client.query(
          `SELECT count(*)::int AS n FROM budget_versions bv
           WHERE bv.status = 'pending_approval'
             AND bv.proposed_by <> $1
             AND app_user_has_role('budget_approver')`,
          [user.id],
        ),
        client.query(
          `SELECT count(*)::int AS n FROM doa_matrix_versions dv
           WHERE dv.status = 'draft'
             AND dv.uploaded_by <> $1
             AND app_user_has_role('doa_approver')`,
          [user.id],
        ),
      ]);

      const [pendingApproval, myOpen, deniedThisMonth] = await Promise.all([
        client.query(
          `SELECT count(*)::int AS n
           FROM approval_steps st
           JOIN requisitions r ON r.id = st.requisition_id
           WHERE st.decision = 'pending'
             AND (st.assigned_user_id = $1
                  OR app_user_is_delegate_for(st.assigned_user_id, r.cost_centre_id))
             AND ((st.purpose = 'doa' AND r.status = 'submitted'
                   AND app_user_has_role('approver', r.cost_centre_id)
                   AND NOT EXISTS (SELECT 1 FROM approval_steps prev
                                   WHERE prev.requisition_id = st.requisition_id
                                     AND prev.purpose = 'doa' AND prev.step_no < st.step_no
                                     AND prev.decision <> 'approved'))
                  -- The Accounts final-review step (0014) counts for the
                  -- org-wide accounting role, mirroring the approvals queue.
                  OR (st.purpose = 'finance_review' AND r.status = 'submitted'
                      AND app_user_has_role('accounting')
                      AND NOT EXISTS (SELECT 1 FROM approval_steps prev
                                      WHERE prev.requisition_id = st.requisition_id
                                        AND prev.purpose = 'doa'
                                        AND prev.decision <> 'approved'))
                  OR (st.purpose = 'variance_reapproval' AND r.status IN ('approved','closed')
                      AND app_user_has_role('approver', r.cost_centre_id)
                      AND EXISTS (SELECT 1 FROM invoices i
                                  WHERE i.reapproval_step_id = st.id
                                    AND i.status = 'pending_reapproval')))`,
          [user.id],
        ),
        client.query(
          `SELECT count(*)::int AS n FROM requisitions
           WHERE requester_id = $1 AND status IN ('draft', 'submitted', 'approved')`,
          [user.id],
        ),
        client.query(
          `SELECT count(*)::int AS n FROM requisitions r
           WHERE r.status = 'denied'
             AND r.closed_at >= date_trunc('month', now())
             AND (r.requester_id = $1 OR app_user_can_read_cost_centre(r.cost_centre_id))`,
          [user.id],
        ),
      ]);

      // Budget position for every cost centre the user can see budgets for
      const visibleCcs = await client.query<{ id: string; code: string; name: string }>(
        `SELECT DISTINCT cc.id, cc.code, cc.name
         FROM cost_centres cc
         JOIN roles_assignments ra ON ra.revoked_at IS NULL AND ra.user_id = $1
           AND (ra.cost_centre_id = cc.id
                OR (ra.cost_centre_id IS NULL AND ra.role IN ('accounting', 'auditor', 'budget_approver')))
           AND ra.role IN ('requester', 'approver', 'budget_owner', 'accounting', 'auditor', 'budget_approver')
         WHERE cc.active
         ORDER BY cc.code`,
        [user.id],
      );
      const period = await currentPeriod(client);
      const budgets = [];
      for (const cc of visibleCcs.rows.slice(0, 10)) {
        const position = await budgetPosition(client, cc.id, period);
        budgets.push({
          costCentreId: cc.id,
          costCentreCode: cc.code,
          costCentreName: cc.name,
          period,
          totals: position.totals,
          hasActiveBudget: position.budgetVersionId !== null,
        });
      }

      return {
        pendingMyApproval: pendingApproval.rows[0]!.n,
        myOpenRequisitions: myOpen.rows[0]!.n,
        deniedThisMonth: deniedThisMonth.rows[0]!.n,
        pendingBudgetApprovals: pendingBudgets.rows[0]!.n,
        pendingDoaActivations: pendingDoa.rows[0]!.n,
        budgetPositions: budgets,
      };
    });
  });
}
