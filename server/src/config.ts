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
    // Never blindly trust X-Forwarded-For: a spoofable client IP defeats every
    // rate limit and falsifies audit rows. 'false' (direct listen), an integer
    // hop count, or a comma-separated proxy CIDR/IP list.
    TRUST_PROXY: z.string().default('false'),
    // Optional CA bundle path enabling verified TLS to PostgreSQL (A.8.24)
    DB_SSL_CA_FILE: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    // A.8.7: private attachment store — never a statically served path
    ATTACHMENT_DIR: z.string().default('./data/attachments'),
    // A.8.7: 'clamd' (ClamAV daemon, required in production) or 'stub'
    // (dev/test EICAR-only detector — refuses production, see superRefine)
    SCANNER_MODE: z.enum(['clamd', 'stub']).default('stub'),
    CLAMD_HOST: z.string().optional(),
    CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    // Transport ceiling for uploads (A.8.7). Must stay >= the
    // attachment_max_bytes app setting; bodies above it are aborted mid stream.
    UPLOAD_TRANSPORT_LIMIT_MB: z.coerce.number().int().min(1).max(200).default(20),
    // Notification delivery (plan §5.2 / A.5.14): 'smtp' sends via the
    // internal relay; 'off' leaves messages in the outbox (dev/test, or until
    // Massy IT provides the relay — ask-list; the outbox loses nothing).
    EMAIL_MODE: z.enum(['off', 'smtp']).default('off'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
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
    // A.5.14/A.8.24: production must be served over HTTPS — the Secure cookie
    // flag and HSTS are meaningless otherwise.
    if (env.NODE_ENV === 'production' && !env.APP_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'APP_BASE_URL must be https:// in production',
        path: ['APP_BASE_URL'],
      });
    }
    // A.8.7: the EICAR-only stub scanner must be impossible in production
    if (env.NODE_ENV === 'production' && env.SCANNER_MODE !== 'clamd') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SCANNER_MODE must be "clamd" in production (A.8.7 — real malware scanning is not optional)',
        path: ['SCANNER_MODE'],
      });
    }
    if (env.SCANNER_MODE === 'clamd' && !env.CLAMD_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CLAMD_HOST is required when SCANNER_MODE=clamd',
        path: ['CLAMD_HOST'],
      });
    }
    if (env.EMAIL_MODE === 'smtp') {
      for (const key of ['SMTP_HOST', 'SMTP_FROM'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${key} is required when EMAIL_MODE=smtp`,
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
  /** Parsed TRUST_PROXY: false, a hop count, or a proxy address list. */
  trustProxy: boolean | number | string[];
  /**
   * Transport-layer upload ceiling (A.8.7). Bodies above this are aborted mid
   * stream instead of being buffered and then rejected. Set a little above the
   * `attachment_max_bytes` setting so the route returns the precise policy
   * error for normal overshoots; raise both together.
   */
  uploadTransportLimitBytes: number;
};

function parseTrustProxy(raw: string): boolean | number | string[] {
  if (raw === 'false' || raw === '') return false;
  if (raw === 'true') {
    // 'true' would trust any client-supplied X-Forwarded-For — refuse it.
    throw new Error('TRUST_PROXY=true is not allowed: list the proxy addresses/CIDRs or a hop count instead');
  }
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

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
    trustProxy: parseTrustProxy(parsed.data.TRUST_PROXY),
    // 20 MiB: the seeded attachment_max_bytes (15 MiB) plus headroom for
    // multipart framing. Raising attachment_max_bytes past this needs
    // UPLOAD_TRANSPORT_LIMIT_MB raised too.
    uploadTransportLimitBytes: parsed.data.UPLOAD_TRANSPORT_LIMIT_MB * 1024 * 1024,
  };
}
