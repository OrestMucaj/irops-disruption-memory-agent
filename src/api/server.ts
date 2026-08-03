import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle } from './router.js';
import { CORS_HEADERS, getDeps, warnOnModelMismatch } from './shared.js';

/**
 * Local development server.
 *
 *     npm run dev        # then open http://localhost:3000
 *
 * Serves the same router the Lambda serves, plus the static frontend, so the
 * whole thing can be exercised without deploying. In production the frontend
 * comes from S3 and the API from a Lambda Function URL; the API behaviour is
 * identical because it is literally the same `handle` function.
 */

const PORT = Number(process.env.PORT ?? '3000');
const WEB_ROOT = resolve(fileURLToPath(new URL('../../web', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const deps = getDeps();
await warnOnModelMismatch(deps);

const server = createServer((req, res) => {
  void (async () => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await serveApi(method, url, req, res);
      return;
    }

    await serveStatic(url.pathname, res);
  })().catch((err: unknown) => {
    console.error('[server] unhandled', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  });
});

async function serveApi(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');

  let body: unknown = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { ...CORS_HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request body was not valid JSON' }));
      return;
    }
  }

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  const started = Date.now();
  const response = await handle(deps, { method, path: url.pathname, query, body });
  console.log(`${method} ${url.pathname} -> ${response.status} (${Date.now() - started}ms)`);

  res.writeHead(response.status, { ...CORS_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify(response.body));
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  // config.js only exists after a deploy, where it pins the frontend to the
  // Lambda Function URL. Locally, synthesise an empty one so app.js falls back
  // to same-origin /api without a 404 in the console.
  if (pathname === '/config.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] ?? 'text/javascript', 'cache-control': 'no-cache' });
    res.end("window.API_BASE = '';\n");
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  // Confine to WEB_ROOT. `normalize` collapses ../ segments, and the prefix
  // check rejects anything that still escapes -- without this, a request for
  // /../.env would serve the database password.
  const candidate = resolve(join(WEB_ROOT, normalize(relative)));
  if (candidate !== WEB_ROOT && !candidate.startsWith(WEB_ROOT + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('not a file');
    const content = await readFile(candidate);
    res.writeHead(200, {
      'content-type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

server.listen(PORT, () => {
  console.log(`\n  IROPS Disruption Memory Agent`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  embeddings: ${deps.embedder.name} (${deps.embedder.modelId})`);
  console.log(`  reasoning : ${deps.llm.name} (${deps.llm.modelId})\n`);
});
