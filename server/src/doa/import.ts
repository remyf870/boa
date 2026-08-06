// DOA matrix Excel import (plan §6.1). Excel is the input format; the
// database is the system of record. Validation catches: overlapping amount
// bands, gaps between bands, unknown approver names, currency mismatch,
// unknown cost centres, and active categories with no coverage.
import ExcelJS from 'exceljs';
import type pg from 'pg';
import type { ApproverDescriptor } from './engine.js';

export interface ParsedRule {
  rowNo: number;
  categoryCode: string;
  costCentreCode: string | null; // null = all cost centres
  minAmount: number;
  maxAmount: number | null;
  currency: string;
  approvers: ApproverDescriptor[];
  requiresQuotes: number;
  notes: string | null;
}

export interface ResolvedParsedRule extends ParsedRule {
  categoryId: string;
  costCentreId: string | null;
}

export interface DoaValidation {
  /** Blocking: the upload is refused. */
  errors: string[];
  /**
   * Non-blocking but shown to the uploader AND to the second-person reviewer,
   * and recorded in the activation audit entry. These are real routing holes
   * (a band that cannot route in some cost centre) which are nevertheless
   * legitimate during a phased rollout — plan §1 pilots Leasing first, so
   * cost centres with no approvers yet must not block the matrix.
   */
  warnings: string[];
  rules: ResolvedParsedRule[];
}

/** Row cap: a compact xlsx can expand to hundreds of thousands of rows, each
 * costing several validation queries and an INSERT inside one transaction.
 * A real DOA is tens of rows; this bound keeps a malformed or hostile upload
 * from monopolising a connection (adversarial-review finding). */
export const DOA_MAX_ROWS = 2000;

export const DOA_TEMPLATE_COLUMNS = [
  'Category',
  'Cost Centre',
  'Min Amount',
  'Max Amount',
  'Currency',
  'Approver 1',
  'Approver 2',
  'Approver 3',
  'Quotes Required',
  'Notes',
] as const;

function cellText(row: ExcelJS.Row, col: number): string {
  const v = row.getCell(col).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text).trim();
  if (typeof v === 'object' && 'result' in v) return String((v as { result: unknown }).result ?? '').trim();
  return String(v).trim();
}

function cellNumber(row: ExcelJS.Row, col: number): number | null {
  const raw = cellText(row, col).replace(/[, ]/g, '');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** "Finance Manager" → job_title; "user:a@b.c" → user; "role:approver" → role. */
function parseApprover(raw: string): ApproverDescriptor | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = /^(job_title|user|role)\s*:\s*(.+)$/i.exec(trimmed);
  if (m) {
    return { type: m[1]!.toLowerCase() as ApproverDescriptor['type'], value: m[2]!.trim(), label: m[2]!.trim() };
  }
  if (trimmed.includes('@')) return { type: 'user', value: trimmed, label: trimmed };
  return { type: 'job_title', value: trimmed, label: trimmed };
}

export async function parseDoaWorkbook(buffer: Buffer): Promise<{ errors: string[]; rules: ParsedRule[] }> {
  const errors: string[] = [];
  const rules: ParsedRule[] = [];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return { errors: ['The file could not be read as an .xlsx workbook'], rules: [] };
  }
  const ws = wb.worksheets[0];
  if (!ws) return { errors: ['The workbook has no worksheets'], rules: [] };

  // Find the header row (template files carry a labelling block first)
  let headerRowNo = 0;
  ws.eachRow((row, rowNo) => {
    if (headerRowNo === 0 && cellText(row, 1).toLowerCase() === 'category') headerRowNo = rowNo;
  });
  if (headerRowNo === 0) {
    return { errors: ['Header row not found — use the downloadable template (first column header must be "Category")'], rules: [] };
  }

  ws.eachRow((row, rowNo) => {
    if (rowNo <= headerRowNo) return;
    if (rules.length >= DOA_MAX_ROWS) return;
    const categoryCode = cellText(row, 1);
    if (!categoryCode) return; // blank row
    const costCentre = cellText(row, 2);
    const min = cellNumber(row, 3);
    const max = cellNumber(row, 4);
    const currency = cellText(row, 5).toUpperCase();
    const approvers: ApproverDescriptor[] = [];
    for (const col of [6, 7, 8]) {
      const parsed = parseApprover(cellText(row, col));
      if (parsed) approvers.push(parsed);
    }
    const quotes = cellNumber(row, 9) ?? 0;
    const notes = cellText(row, 10) || null;

    if (min === null || Number.isNaN(min) || min < 0) errors.push(`Row ${rowNo}: Min Amount must be a number >= 0`);
    if (max !== null && (Number.isNaN(max) || max <= (min ?? 0))) {
      errors.push(`Row ${rowNo}: Max Amount must be blank (no upper bound) or greater than Min Amount`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) errors.push(`Row ${rowNo}: Currency must be a 3-letter code`);
    if (approvers.length === 0) errors.push(`Row ${rowNo}: at least Approver 1 is required`);
    if (Number.isNaN(quotes) || quotes < 0 || quotes > 10 || !Number.isInteger(quotes)) {
      errors.push(`Row ${rowNo}: Quotes Required must be a whole number between 0 and 10`);
    }

    rules.push({
      rowNo,
      categoryCode: categoryCode.toUpperCase(),
      costCentreCode: costCentre ? costCentre.toUpperCase() : null,
      minAmount: min ?? 0,
      maxAmount: max,
      currency,
      approvers,
      requiresQuotes: Number.isInteger(quotes) ? quotes : 0,
      notes,
    });
  });

  if (rules.length === 0) errors.push('The workbook contains no rules');
  if (rules.length >= DOA_MAX_ROWS) {
    errors.push(
      `The workbook exceeds the ${DOA_MAX_ROWS}-rule limit. A DOA matrix this large is almost certainly a mistake; split it or contact the development team.`,
    );
  }

  // Two rows describing the same category, scope and band contradict each
  // other — resolution would silently pick one (adversarial-review finding).
  const seenBands = new Map<string, number>();
  for (const r of rules) {
    const key = `${r.categoryCode}::${r.costCentreCode ?? '*'}::${r.minAmount}::${r.maxAmount ?? 'open'}`;
    const first = seenBands.get(key);
    if (first !== undefined) {
      errors.push(`Row ${r.rowNo}: duplicates the band already defined on row ${first}`);
    } else {
      seenBands.set(key, r.rowNo);
    }
  }
  return { errors, rules };
}

/** Semantic validation against the database (plan §6.1). */
export async function validateDoaRules(
  client: Pick<pg.PoolClient, 'query'>,
  parsed: ParsedRule[],
  baseCurrency: string,
): Promise<DoaValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const categories = await client.query<{ id: string; code: string }>(
    'SELECT id, code FROM categories WHERE active',
  );
  const categoryByCode = new Map(categories.rows.map((c) => [c.code.toUpperCase(), c.id]));
  const costCentres = await client.query<{ id: string; code: string }>(
    'SELECT id, code FROM cost_centres WHERE active',
  );
  const costCentreByCode = new Map(costCentres.rows.map((c) => [c.code.toUpperCase(), c.id]));
  const costCentreCodeById = new Map(costCentres.rows.map((c) => [c.id, c.code]));

  const resolved: ResolvedParsedRule[] = [];
  for (const rule of parsed) {
    const categoryId = categoryByCode.get(rule.categoryCode);
    if (!categoryId) {
      errors.push(`Row ${rule.rowNo}: unknown category "${rule.categoryCode}"`);
      continue;
    }
    let costCentreId: string | null = null;
    if (rule.costCentreCode) {
      costCentreId = costCentreByCode.get(rule.costCentreCode) ?? null;
      if (!costCentreId) {
        errors.push(`Row ${rule.rowNo}: unknown cost centre "${rule.costCentreCode}"`);
        continue;
      }
    }
    if (rule.currency !== baseCurrency) {
      errors.push(`Row ${rule.rowNo}: currency ${rule.currency} does not match the base currency ${baseCurrency}`);
    }
    // Unknown approver names: a job title must match at least one ACTIVE user;
    // an email must match an active user. Role descriptors resolve at submit.
    // Approver descriptors must resolve the SAME way the engine resolves them
    // at submit time — an active user holding the approver role for the rule's
    // scope. Checking only "an active user has this job title" let clean
    // matrices contain permanently dead bands (adversarial-review finding).
    for (const a of rule.approvers) {
      if (a.type === 'role') {
        if (a.value !== 'approver') {
          errors.push(`Row ${rule.rowNo}: role descriptors must be "role:approver"`);
          continue;
        }
      }
      const scopes = costCentreId ? [costCentreId] : costCentres.rows.map((c) => c.id);
      const unresolved: string[] = [];
      for (const scope of scopes) {
        const match = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n
           FROM users u
           JOIN roles_assignments ra ON ra.user_id = u.id
             AND ra.role = 'approver' AND ra.revoked_at IS NULL
             AND (ra.cost_centre_id = $1 OR ra.cost_centre_id IS NULL)
           WHERE u.status = 'active'
             AND ($3::text = 'role'
                  OR ($3::text = 'job_title' AND lower(u.job_title) = lower($2))
                  OR ($3::text = 'user' AND lower(u.email) = lower($2)))`,
          [scope, a.value, a.type],
        );
        if (Number(match.rows[0]!.n) === 0) {
          unresolved.push(costCentreCodeById.get(scope) ?? scope);
        }
      }
      if (unresolved.length > 0) {
        const who =
          a.type === 'role'
            ? 'no active user holds the approver role'
            : `no active user matching "${a.value}" holds the approver role`;
        const message =
          `Row ${rule.rowNo}: ${who} for cost centre${unresolved.length > 1 ? 's' : ''} ${unresolved.join(', ')} — ` +
          'requisitions in those cost centres cannot be routed by this rule';
        // Dead in EVERY scope the rule covers = a broken rule, refuse it.
        // Dead in only some = expected during a phased rollout, warn loudly.
        if (unresolved.length === scopes.length) errors.push(message);
        else warnings.push(message);
      }
    }
    resolved.push({ ...rule, categoryId, costCentreId });
  }

  // Band integrity per (category, cost-centre scope): no overlaps, no gaps,
  // starting at 0, ending open (plan §6.1).
  const groups = new Map<string, ResolvedParsedRule[]>();
  for (const r of resolved) {
    const key = `${r.categoryCode}::${r.costCentreCode ?? '*'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.minAmount - b.minAmount);
    const label = key.replace('::', ' / cost centre ');
    if (sorted[0]!.minAmount !== 0) {
      errors.push(`${label}: the first band must start at 0 (starts at ${sorted[0]!.minAmount})`);
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i]!;
      const nxt = sorted[i + 1]!;
      if (cur.maxAmount === null) {
        errors.push(`${label}: row ${cur.rowNo} has no upper bound but is not the last band`);
      } else if (nxt.minAmount < cur.maxAmount) {
        errors.push(`${label}: rows ${cur.rowNo} and ${nxt.rowNo} overlap (bands must not overlap)`);
      } else if (nxt.minAmount > cur.maxAmount) {
        errors.push(`${label}: gap between ${cur.maxAmount} (row ${cur.rowNo}) and ${nxt.minAmount} (row ${nxt.rowNo})`);
      }
    }
    if (sorted[sorted.length - 1]!.maxAmount !== null) {
      errors.push(`${label}: the last band must have no upper bound (blank Max Amount)`);
    }
  }

  // Coverage: every active category must be routable from every active cost
  // centre. A category covered only by cost-centre-specific rules leaves the
  // other cost centres with no matching rule at submit time — the runtime hole
  // validation is supposed to catch (adversarial-review finding).
  const globalCoverage = new Set(resolved.filter((r) => r.costCentreCode === null).map((r) => r.categoryCode));
  const scopedCoverage = new Set(
    resolved.filter((r) => r.costCentreCode !== null).map((r) => `${r.categoryCode}::${r.costCentreCode}`),
  );
  for (const c of categories.rows) {
    const code = c.code.toUpperCase();
    if (globalCoverage.has(code)) continue;
    const uncovered = costCentres.rows
      .filter((cc) => !scopedCoverage.has(`${code}::${cc.code.toUpperCase()}`))
      .map((cc) => cc.code);
    if (uncovered.length === costCentres.rows.length) {
      errors.push(`Category "${c.code}" is active but has no rule in this matrix`);
    } else if (uncovered.length > 0) {
      warnings.push(
        `Category "${c.code}" has no rule covering cost centre${uncovered.length > 1 ? 's' : ''} ${uncovered.join(', ')} — ` +
          'requisitions there will be refused at submission; add a blank-cost-centre (all) row or a row per cost centre',
      );
    }
  }

  return { errors, warnings, rules: resolved };
}

export interface DoaDiffEntry {
  categoryCode: string;
  costCentreCode: string | null;
  band: string;
  change: 'added' | 'removed' | 'changed';
  detail?: string;
}

/** Line-by-line diff of the parsed rules against the active version. */
export async function diffAgainstActive(
  client: Pick<pg.PoolClient, 'query'>,
  incoming: ResolvedParsedRule[],
): Promise<{ activeVersionNo: number | null; entries: DoaDiffEntry[] }> {
  const active = await client.query<{
    version_no: number;
    category_code: string;
    cost_centre_code: string | null;
    min_amount: string;
    max_amount: string | null;
    approval_sequence: unknown;
    requires_quotes: number;
    notes: string | null;
  }>(
    `SELECT dv.version_no, cat.code AS category_code, cc.code AS cost_centre_code,
            dr.min_amount, dr.max_amount, dr.approval_sequence, dr.requires_quotes, dr.notes
     FROM doa_rules dr
     JOIN doa_matrix_versions dv ON dv.id = dr.version_id AND dv.status = 'active'
     JOIN categories cat ON cat.id = dr.category_id
     LEFT JOIN cost_centres cc ON cc.id = dr.cost_centre_id`,
  );

  const keyOf = (cat: string, cc: string | null, min: number, max: number | null) =>
    `${cat.toUpperCase()}::${cc?.toUpperCase() ?? '*'}::${min}::${max ?? 'open'}`;
  // The reviewer approving this diff is the second half of the §6.1 two-person
  // control, so the description must show everything that changes routing:
  // descriptor TYPE as well as value (role:approver and job_title:approver are
  // different rules), quotes, and notes (adversarial-review finding).
  const describe = (seq: unknown, quotes: number, notes: string | null) =>
    `${(Array.isArray(seq) ? seq : [])
      .map((d) => {
        const desc = d as { type?: string; value?: string };
        return `${desc.type ?? '?'}:${desc.value ?? '?'}`;
      })
      .join(' → ')} | quotes: ${quotes} | notes: ${notes ?? '—'}`;

  const activeByKey = new Map(
    active.rows.map((r) => [
      keyOf(r.category_code, r.cost_centre_code, Number(r.min_amount), r.max_amount === null ? null : Number(r.max_amount)),
      r,
    ]),
  );
  const entries: DoaDiffEntry[] = [];
  const seen = new Set<string>();

  for (const r of incoming) {
    const key = keyOf(r.categoryCode, r.costCentreCode, r.minAmount, r.maxAmount);
    seen.add(key);
    const band = `${r.minAmount} – ${r.maxAmount ?? 'no limit'}`;
    const existing = activeByKey.get(key);
    if (!existing) {
      entries.push({
        categoryCode: r.categoryCode,
        costCentreCode: r.costCentreCode,
        band,
        change: 'added',
        detail: describe(r.approvers, r.requiresQuotes, r.notes),
      });
    } else {
      const before = describe(existing.approval_sequence, existing.requires_quotes, existing.notes);
      const after = describe(r.approvers, r.requiresQuotes, r.notes);
      if (before !== after) {
        entries.push({
          categoryCode: r.categoryCode,
          costCentreCode: r.costCentreCode,
          band,
          change: 'changed',
          detail: `${before}  →  ${after}`,
        });
      }
    }
  }
  for (const [key, r] of activeByKey) {
    if (!seen.has(key)) {
      entries.push({
        categoryCode: r.category_code,
        costCentreCode: r.cost_centre_code,
        band: `${Number(r.min_amount)} – ${r.max_amount === null ? 'no limit' : Number(r.max_amount)}`,
        change: 'removed',
        detail: describe(r.approval_sequence, r.requires_quotes, r.notes),
      });
    }
  }

  return { activeVersionNo: active.rows[0]?.version_no ?? null, entries };
}
