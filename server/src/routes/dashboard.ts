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
      const [pendingApproval, myOpen, deniedThisMonth] = await Promise.all([
        client.query(
          `SELECT count(*)::int AS n
           FROM approval_steps st
           JOIN requisitions r ON r.id = st.requisition_id
           WHERE st.decision = 'pending'
             AND app_user_has_role('approver', r.cost_centre_id)
             AND (st.assigned_user_id = $1
                  OR app_user_is_delegate_for(st.assigned_user_id, r.cost_centre_id))
             AND ((st.purpose = 'doa' AND r.status = 'submitted'
                   AND NOT EXISTS (SELECT 1 FROM approval_steps prev
                                   WHERE prev.requisition_id = st.requisition_id
                                     AND prev.purpose = 'doa' AND prev.step_no < st.step_no
                                     AND prev.decision <> 'approved'))
                  OR (st.purpose = 'variance_reapproval' AND r.status IN ('approved','closed')))`,
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
        budgetPositions: budgets,
      };
    });
  });
}
