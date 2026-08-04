// Application assembly. Security middleware order matters:
// helmet (headers) → rate limit → cookies → auth context (session, CSRF,
// banner gate) → routes. Errors never leak internals (A.8.28).
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import authContext from './plugins/auth-context.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import adminRoutes from './routes/admin.js';
import requisitionRoutes from './routes/requisitions.js';

export async function buildApp(config: Config, db: Db): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log cookies or auth headers (A.8.15 logs events, not secrets)
      redact: ['req.headers.cookie', 'req.headers.authorization'],
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024, // 1 MiB JSON bodies; file uploads get their own route + limits in Phase 2
  });

  // A.8.28: CSP, HSTS, X-Frame-Options, X-Content-Type-Options
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind inlines a style block in the built SPA
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    strictTransportSecurity: {
      maxAge: 63072000,
      includeSubDomains: true,
    },
    xFrameOptions: { action: 'deny' },
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });

  await app.register(authContext, { db, config });

  await app.register(meRoutes, { db, config });
  await app.register(authRoutes, { db, config });
  await app.register(adminRoutes, { db, config });
  await app.register(requisitionRoutes, { db, config });

  // Serve the built SPA in production (same origin — no CORS surface at all)
  if (config.WEB_DIST_DIR) {
    await app.register(fastifyStatic, {
      root: path.resolve(config.WEB_DIST_DIR),
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  }

  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Rate limit errors keep their status; everything else is sanitised
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error' });
    }
    return reply.code(status).send({ error: err.code ?? 'request_error', message: err.message });
  });

  return app;
}
