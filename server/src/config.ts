// All configuration via environment variables — zero secrets in the repo (A.8.9).
// Validation is fail-fast: a misconfigured server refuses to start.
import 'dotenv/config';
import { z } from 'zod';

const hexSecret = z
  .string()
  .regex(/^[0-9a-f]{64,}$/i, 'must be at least 64 hex characters (crypto.randomBytes(32).toString("hex"))');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    APP_BASE_URL: z.string().url(),
    DATABASE_URL: z.string().min(1),
    SESSION_SECRET: hexSecret,
    BREAK_GLASS_KEY: hexSecret,
    AUTH_MODE: z.enum(['entra', 'dev']).default('entra'),
    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    OIDC_REDIRECT_URI: z.string().url().optional(),
    WEB_DIST_DIR: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((env, ctx) => {
    // A.5.16 / A.8.5: production authenticates via Entra ID only. The dev
    // stub must be impossible to enable in production.
    if (env.NODE_ENV === 'production' && env.AUTH_MODE !== 'entra') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AUTH_MODE must be "entra" in production (plan §2: Entra ID SSO is not optional)',
        path: ['AUTH_MODE'],
      });
    }
    if (env.AUTH_MODE === 'entra') {
      for (const key of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'OIDC_REDIRECT_URI'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${key} is required when AUTH_MODE=entra`,
            path: [key],
          });
        }
      }
    }
  });

export type Config = z.infer<typeof schema> & {
  /** Session policy per A.8.5 */
  session: { idleMinutes: number; absoluteHours: number };
  bannerVersion: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid server configuration:\n${details}`);
  }
  return {
    ...parsed.data,
    // A.8.5: 30 min idle / 8 h absolute. Policy constants, not client-tunable.
    session: { idleMinutes: 30, absoluteHours: 8 },
    // Bump when the acceptable-use text changes; users re-acknowledge (A.5.10).
    bannerVersion: 1,
  };
}
