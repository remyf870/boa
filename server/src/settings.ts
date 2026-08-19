// Configurable values are data in the database, never code constants
// (plan §0.3). This module is the single typed read/write path for
// app_settings; every change is audited with before/after (A.8.15).
import { z } from 'zod';
import type pg from 'pg';

const SETTING_SCHEMAS = {
  base_currency: z.string().length(3),
  sla_reminder_days: z.number().int().min(1).max(90),
  sla_escalation_days: z.number().int().min(1).max(180),
  invoice_variance_tolerance: z.number().min(0).max(1),
  fiscal_year_start_month: z.number().int().min(1).max(12),
  attachment_max_bytes: z
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024),
  budget_required_approvals: z.number().int().min(1).max(5),
  accounting_final_approval: z.boolean(),
  allowed_email_domains: z.array(z.string().min(1).max(253)).max(50),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };

export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** Read every setting, validated. A missing or malformed row is a hard error —
 * migrations seed every key (0008, 0014), so absence means the database is
 * behind the code (the startup guard in index.ts refuses that in production)
 * or tampered with, and guessing a default silently would defeat plan §0.3. */
export async function readSettings(db: Queryable): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM app_settings');
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Partial<Record<SettingKey, unknown>> = {};
  for (const key of SETTING_KEYS) {
    if (!byKey.has(key)) throw new Error(`app_settings is missing required key "${key}"`);
    const parsed = SETTING_SCHEMAS[key].safeParse(byKey.get(key));
    if (!parsed.success) throw new Error(`app_settings.${key} is malformed: ${parsed.error.issues[0]?.message}`);
    out[key] = parsed.data;
  }
  return out as Settings;
}

export async function readSetting<K extends SettingKey>(db: Queryable, key: K): Promise<Settings[K]> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  if (rows.length === 0) throw new Error(`app_settings is missing required key "${key}"`);
  const parsed = SETTING_SCHEMAS[key].safeParse(rows[0]!.value);
  if (!parsed.success) throw new Error(`app_settings.${key} is malformed: ${parsed.error.issues[0]?.message}`);
  return parsed.data as Settings[K];
}

/** Validate + write one setting. Returns {before, after} for the caller's audit entry. */
export async function writeSetting(
  db: Queryable,
  key: SettingKey,
  value: unknown,
  updatedBy: string,
): Promise<{ before: unknown; after: unknown }> {
  const parsed = SETTING_SCHEMAS[key].safeParse(value);
  if (!parsed.success) {
    throw new SettingValidationError(`${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
  }
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1 FOR UPDATE',
    [key],
  );
  if (rows.length === 0) throw new Error(`app_settings is missing required key "${key}"`);
  await db.query('UPDATE app_settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1', [
    key,
    JSON.stringify(parsed.data),
    updatedBy,
  ]);
  return { before: rows[0]!.value, after: parsed.data };
}

export class SettingValidationError extends Error {}
