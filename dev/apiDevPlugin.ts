import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * Local development only: serves /api/* from server/router.ts inside the Vite dev server,
 * backed by an embedded Postgres (PGlite) stored in ./.pglite — unless DATABASE_URL is set,
 * in which case the real database is used. Not part of the production build.
 */
export function apiDevPlugin(): Plugin {
  return {
    name: 'gcash-api-dev',
    apply: 'serve',
    configureServer(server) {
      process.env.SETUP_CODE ??= 'dev-setup';
      let ready: Promise<void> | null = null;

      const init = () =>
        (ready ??= (async () => {
          if (process.env.DATABASE_URL || process.env.POSTGRES_URL) return;
          const { PGlite } = await import('@electric-sql/pglite');
          const pg = new PGlite(process.env.PGLITE_DIR ?? './.pglite');
          globalThis.__gcashQuery = (async (text: string, params: unknown[] = []) =>
            (await pg.query(text, params)).rows) as typeof globalThis.__gcashQuery;
          server.config.logger.info('  ➜  API: using embedded Postgres (PGlite) in ./.pglite');
        })());

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        if (!/^\/api(\/|\?|$)/.test(req.url ?? '')) return next();
        try {
          await init();
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const request = new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
          });
          const { handle } = (await server.ssrLoadModule('/server/router.ts')) as typeof import('../server/router');
          const response = await handle(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          next(e);
        }
      });
    },
  };
}
