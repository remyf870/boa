// Live budget position (plan §4 design rule 2, §5.9):
//   Available = Budget − Committed − Actual
// Committed  = approved (not yet closed/cancelled) requisition amounts minus
//              what their posted invoices already actualised — never below 0.
// Actual     = posted invoice amounts, attributed to the requisition's
//              commitment period (the fiscal period of final approval —
//              ASSUMPTIONS §2.2a).
// Always computed from base records under the caller's RLS context — there is
// no stored running total that can drift. The reporting view
// reporting.v_budget_position (0009) implements the same arithmetic for BI.
import type pg from 'pg';

export interface CategoryPosition {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  currency: string;
  budget: string;
  committed: string;
  actual: string;
  available: string;
}

export interface BudgetPosition {
  costCentreId: string;
  period: string;
  /** Null when no active budget version exists for the period. */
  budgetVersionId: string | null;
  categories: CategoryPosition[];
  totals: { budget: string; committed: string; actual: string; available: string };
}

/** The fiscal period (e.g. FY2026-Q3) a timestamp falls in — DB is authoritative
 * (fiscal_year_start_month lives in app_settings). */
export async function currentPeriod(client: Pick<pg.PoolClient, 'query'>, at?: Date): Promise<string> {
  const { rows } = await client.query<{ p: string }>('SELECT fiscal_period_of($1::timestamptz) AS p', [
    at ?? new Date(),
  ]);
  return rows[0]!.p;
}

export async function budgetPosition(
  client: Pick<pg.PoolClient, 'query'>,
  costCentreId: string,
  period: string,
): Promise<BudgetPosition> {
  const version = await client.query<{ id: string }>(
    `SELECT id FROM budget_versions WHERE cost_centre_id = $1 AND period = $2 AND status = 'active'`,
    [costCentreId, period],
  );
  const versionId = version.rows[0]?.id ?? null;

  // One row per category that has either a budget line or movement.
  const { rows } = await client.query<{
    category_id: string;
    category_code: string;
    category_name: string;
    currency: string;
    budget: string;
    committed: string;
    actual: string;
  }>(
    `WITH lines AS (
       SELECT b.category_id, b.amount, b.currency
       FROM budgets b
       WHERE b.version_id = $3::uuid
     ),
     req AS (
       SELECT r.id, r.category_id, r.amount, r.status
       FROM requisitions r
       WHERE r.cost_centre_id = $1
         AND r.approved_at IS NOT NULL
         AND fiscal_period_of(r.approved_at) = $2
     ),
     posted AS (
       SELECT i.requisition_id, sum(i.amount) AS posted_amount
       FROM invoices i
       JOIN req r ON r.id = i.requisition_id
       WHERE i.status = 'posted'
       GROUP BY i.requisition_id
     ),
     movement AS (
       SELECT r.category_id,
              sum(CASE WHEN r.status = 'approved'
                       THEN greatest(r.amount - coalesce(p.posted_amount, 0), 0)
                       ELSE 0 END) AS committed,
              sum(coalesce(p.posted_amount, 0)) AS actual
       FROM req r
       LEFT JOIN posted p ON p.requisition_id = r.id
       GROUP BY r.category_id
     ),
     merged AS (
       SELECT coalesce(l.category_id, m.category_id) AS category_id,
              coalesce(l.amount, 0)     AS budget,
              coalesce(l.currency, '')  AS currency,
              coalesce(m.committed, 0)  AS committed,
              coalesce(m.actual, 0)     AS actual
       FROM lines l
       FULL OUTER JOIN movement m ON m.category_id = l.category_id
     )
     SELECT mg.category_id, cat.code AS category_code, cat.name AS category_name,
            mg.currency, mg.budget::text, mg.committed::text, mg.actual::text
     FROM merged mg
     JOIN categories cat ON cat.id = mg.category_id
     ORDER BY cat.code`,
    [costCentreId, period, versionId],
  );

  const categories: CategoryPosition[] = rows.map((r) => ({
    categoryId: r.category_id,
    categoryCode: r.category_code,
    categoryName: r.category_name,
    currency: r.currency,
    budget: r.budget,
    committed: r.committed,
    actual: r.actual,
    available: (Number(r.budget) - Number(r.committed) - Number(r.actual)).toFixed(2),
  }));

  const sum = (f: (c: CategoryPosition) => string) =>
    categories.reduce((acc, c) => acc + Number(f(c)), 0).toFixed(2);

  return {
    costCentreId,
    period,
    budgetVersionId: versionId,
    categories,
    totals: {
      budget: sum((c) => c.budget),
      committed: sum((c) => c.committed),
      actual: sum((c) => c.actual),
      available: sum((c) => c.available),
    },
  };
}

/** Available for one category — what the requisition form and each approver
 * sees before deciding (plan §5.1, §5.2). */
export async function categoryAvailable(
  client: Pick<pg.PoolClient, 'query'>,
  costCentreId: string,
  categoryId: string,
  period: string,
): Promise<{ budget: number; committed: number; actual: number; available: number }> {
  const position = await budgetPosition(client, costCentreId, period);
  const cat = position.categories.find((c) => c.categoryId === categoryId);
  if (!cat) return { budget: 0, committed: 0, actual: 0, available: 0 };
  return {
    budget: Number(cat.budget),
    committed: Number(cat.committed),
    actual: Number(cat.actual),
    available: Number(cat.available),
  };
}
