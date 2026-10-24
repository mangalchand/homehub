import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { prisma } from './db.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { registry } from './lib/route.js';
import { authenticate, csrfProtection } from './auth/session.js';
import { authRouter } from './routes/auth.js';
import { householdRootRouter, householdRouter } from './routes/households.js';
import { calendarsRouter } from './routes/calendars.js';
import { eventsRouter } from './routes/events.js';
import { integrationCallbackRouter, integrationsRouter } from './routes/integrations.js';
import { tasksRouter } from './routes/tasks.js';
import { homeRouter } from './routes/home.js';
import { logger } from './logger.js';

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'FamilyHub Pro API', version: '1.0.0', description: 'Household calendar, tasks, lists and dashboard API. Authenticate with the session cookie and send the CSRF token header on writes.' },
    servers: [{ url: config.API_PUBLIC_URL }],
  });
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cors({ origin: config.WEB_ORIGIN.split(','), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((req, _res, next) => {
    if (config.NODE_ENV !== 'test') logger.debug({ method: req.method, url: req.originalUrl }, 'request');
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, database: 'up' });
    } catch {
      res.status(503).json({ ok: false, database: 'down' });
    }
  });

  app.use(authenticate);
  app.use(csrfProtection(['/api/v1/integrations/google/callback', '/api/v1/integrations/microsoft/callback', '/api/v1/auth/google/callback']));

  app.use(authRouter());
  app.use(integrationCallbackRouter());
  app.use(householdRootRouter());
  const scoped = '/api/v1/households/:householdId';
  app.use(scoped, householdRouter());
  app.use(scoped, calendarsRouter());
  app.use(scoped, eventsRouter());
  app.use(scoped, integrationsRouter());
  app.use(scoped, tasksRouter());
  app.use(scoped, homeRouter());

  const doc = buildOpenApiDocument();
  app.get('/api/openapi.json', (_req, res) => res.json(doc));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(doc as Parameters<typeof swaggerUi.setup>[0]));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
