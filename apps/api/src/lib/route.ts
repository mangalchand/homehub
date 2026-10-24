import type { NextFunction, Request, Response, Router, RequestHandler } from 'express';
import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z, type ZodTypeAny } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const errorSchema = registry.register(
  'Error',
  z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) }),
);

registry.registerComponent('securitySchemes', 'sessionCookie', {
  type: 'apiKey',
  in: 'cookie',
  name: 'fh_session',
});

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec<B extends ZodTypeAny | undefined, Q extends ZodTypeAny | undefined> {
  method: Method;
  path: string;
  summary: string;
  tags: string[];
  body?: B;
  query?: Q;
  status?: number;
  auth?: boolean;
  middleware?: RequestHandler[];
  /** Skip JSON response handling (streams, redirects, file downloads). */
  raw?: boolean;
}

type Infer<T> = T extends ZodTypeAny ? z.infer<T> : undefined;

export interface Mount {
  router: Router;
  prefix: string; // OpenAPI path prefix, e.g. /api/v1/households/{householdId}
}

/** Registers an Express route with zod validation and an OpenAPI path entry in one place. */
export function route<B extends ZodTypeAny | undefined = undefined, Q extends ZodTypeAny | undefined = undefined>(
  mount: Mount,
  spec: RouteSpec<B, Q>,
  handler: (req: Request, res: Response, input: { body: Infer<B>; query: Infer<Q> }) => Promise<unknown> | unknown,
) {
  const fullPath = (mount.prefix + spec.path).replace(/:(\w+)/g, '{$1}');
  const paramNames = [...fullPath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  registry.registerPath({
    method: spec.method,
    path: fullPath,
    summary: spec.summary,
    tags: spec.tags,
    security: spec.auth === false ? [] : [{ sessionCookie: [] }],
    request: {
      params: paramNames.length
        ? z.object(Object.fromEntries(paramNames.map((p) => [p, z.string()])))
        : undefined,
      query: spec.query instanceof z.ZodObject ? spec.query : undefined,
      body: spec.body ? { content: { 'application/json': { schema: spec.body } } } : undefined,
    },
    responses: {
      [spec.status ?? 200]: { description: 'Success' },
      400: { description: 'Validation error', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: errorSchema } } },
      403: { description: 'Forbidden', content: { 'application/json': { schema: errorSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
    },
  });

  const wrapped = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (spec.body ? spec.body.parse(req.body ?? {}) : undefined) as Infer<B>;
      const query = (spec.query ? spec.query.parse(req.query) : undefined) as Infer<Q>;
      const result = await handler(req, res, { body, query });
      if (spec.raw || res.headersSent) return;
      if (result === undefined) res.status(spec.status ?? 204).end();
      else res.status(spec.status ?? 200).json(result);
    } catch (err) {
      next(err);
    }
  };
  mount.router[spec.method](spec.path, ...(spec.middleware ?? []), wrapped);
}
