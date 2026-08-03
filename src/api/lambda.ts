import { handle } from './router.js';
import { getDeps, warnOnModelMismatch } from './shared.js';

/**
 * AWS Lambda handler for a **Function URL**.
 *
 * Function URL rather than API Gateway or an ALB, deliberately: it has no
 * hourly charge and costs nothing while idle. SPEC §3 requires the demo to stay
 * live from Aug 19 to Sep 15 on no budget, and an ALB alone would be $30-50 for
 * that window (NOTES.md §6.5).
 *
 * Event shape is the Function URL / API Gateway v2 payload format:
 *   { requestContext: { http: { method, path } }, rawQueryString, body,
 *     isBase64Encoded }
 *
 * CORS IS NOT SET HERE, deliberately. The Function URL's own `--cors` config
 * adds the headers, and if the handler adds them too the response carries TWO
 * `Access-Control-Allow-Origin` headers. The CORS spec permits exactly one, so
 * every browser rejects the response with an opaque "Failed to fetch" -- while
 * curl, which does not enforce CORS, reports a perfectly healthy 200. That
 * combination is unpleasant to debug, so: the Function URL owns CORS in
 * deployment, and src/api/server.ts owns it locally.
 */

interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  rawQueryString?: string;
  body?: string;
  isBase64Encoded?: boolean;
}

interface FunctionUrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

let startupChecked = false;

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResponse> {
  const deps = getDeps();

  if (!startupChecked) {
    startupChecked = true;
    await warnOnModelMismatch(deps);
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.requestContext?.http?.path ?? event.rawPath ?? '/';

  // Preflight is answered by the Function URL itself and never reaches here.
  // Handled anyway so the adapter stays correct if CORS config is ever removed.
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: {}, body: '' };
  }

  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(event.rawQueryString ?? '')) {
    query[key] = value;
  }

  let body: unknown = null;
  if (typeof event.body === 'string' && event.body.length > 0) {
    const raw = event.isBase64Encoded === true
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'request body was not valid JSON' });
    }
  }

  try {
    const response = await handle(deps, { method, path, query, body });
    return json(response.status, response.body);
  } catch (err) {
    // Never leak an internal error message to a public endpoint. The detail
    // goes to CloudWatch; the caller gets a request-shaped answer.
    console.error('[api] unhandled error', err);
    return json(500, { error: 'internal error' });
  }
}

function json(statusCode: number, body: unknown): FunctionUrlResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
