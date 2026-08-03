/**
 * Minimal MCP client over streamable HTTP, for the CockroachDB Cloud Managed
 * MCP Server.
 *
 * Hand-rolled rather than pulling in @modelcontextprotocol/sdk, deliberately:
 * the connection mechanics are fully documented (NOTES.md §2.5 — endpoint,
 * `Authorization: Bearer`, `mcp-cluster-id` header, streamable HTTP with SSE
 * responses), the client needs exactly three operations (initialize,
 * tools/list, tools/call), and every dependency added here also ships in the
 * Lambda bundle. ~150 lines beats a transitive tree. If the server ever
 * outgrows this, swap the SDK in behind the same interface.
 *
 * SPEC §10 fallback rule applies: if the handshake fights back for more than
 * ~30 minutes, take the SDK instead of debugging transport arcana.
 */

export interface McpToolDef {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: {
    readonly type?: string;
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

export interface McpConnectResult {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly protocolVersion: string;
  readonly tools: readonly McpToolDef[];
}

export class McpError extends Error {
  public readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'McpError';
    this.status = status;
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class McpClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly clusterId: string;
  private readonly timeoutMs: number;

  private sessionId: string | null = null;
  private protocolVersion = '2025-06-18';
  private nextId = 1;
  public tools: readonly McpToolDef[] = [];

  constructor(options: { url: string; apiKey: string; clusterId: string; timeoutMs?: number }) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.clusterId = options.clusterId;
    this.timeoutMs = options.timeoutMs ?? 25_000;
  }

  /** initialize → notifications/initialized → tools/list. */
  public async connect(): Promise<McpConnectResult> {
    const init = await this.rpc('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: 'irops-memory-analyst', version: '0.1.0' },
    }) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };

    if (typeof init.protocolVersion === 'string') {
      this.protocolVersion = init.protocolVersion;
    }

    await this.notify('notifications/initialized');

    const listed = await this.rpc('tools/list', {}) as { tools?: McpToolDef[] };
    this.tools = Array.isArray(listed.tools) ? listed.tools : [];

    return {
      serverName: init.serverInfo?.name ?? 'unknown',
      serverVersion: init.serverInfo?.version ?? 'unknown',
      protocolVersion: this.protocolVersion,
      tools: this.tools,
    };
  }

  /**
   * Calls a tool and returns its text content.
   *
   * The MCP result shape is { content: [{type:'text', text}...], isError? }.
   * A tool-level failure (isError) throws — the CockroachDB server uses it for
   * SQL errors, permission refusals and limit violations, and callers must not
   * mistake those for data.
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.rpc('tools/call', { name, arguments: args }) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };

    const text = (result.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');

    if (result.isError === true) {
      throw new McpError(`tool ${name} failed: ${text || '(no detail)'}`);
    }
    return text;
  }

  // -------------------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.apiKey}`,
      // Scopes the session to one cluster (NOTES.md §2.5). Without it the
      // session is org-wide, which is more surface than the analyst needs.
      'mcp-cluster-id': this.clusterId,
      'mcp-protocol-version': this.protocolVersion,
    };
    if (this.sessionId !== null) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  private async post(body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new McpError(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(method: string): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method });
    // 202 Accepted with no body is the expected answer to a notification.
    if (!response.ok && response.status !== 202) {
      throw new McpError(`notification ${method} rejected (HTTP ${response.status})`, response.status);
    }
    // Drain so the connection can be reused.
    await response.text().catch(() => '');
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const response = await this.post({ jsonrpc: '2.0', id, method, params });

    // The session header can arrive on any response, but initialize is where
    // it matters; keep whatever the server most recently issued.
    const session = response.headers.get('mcp-session-id');
    if (session !== null && session !== '') this.sessionId = session;

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      const hint =
        response.status === 401 ? ' (API key rejected — check MCP_API_KEY)'
        : response.status === 403 ? ' (permission denied — the service account needs Cluster Operator on this cluster)'
        : response.status === 404 ? ' (check MCP_URL and MCP_CLUSTER_ID)'
        : '';
      throw new McpError(`${method} → HTTP ${response.status}${hint}: ${detail}`, response.status);
    }

    const message = await this.readMessage(response, id);
    if (message.error !== undefined) {
      throw new McpError(`${method} → JSON-RPC error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown'}`);
    }
    return message.result;
  }

  /**
   * Streamable HTTP responses come back as plain JSON or as an SSE stream
   * carrying JSON-RPC messages in `data:` lines. Accept both, return the
   * message whose id matches ours, ignore anything else (server-initiated
   * notifications are legal on the stream).
   */
  private async readMessage(response: Response, id: number): Promise<JsonRpcMessage> {
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();

    if (!contentType.includes('text/event-stream')) {
      const parsed = JSON.parse(raw) as JsonRpcMessage | JsonRpcMessage[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const match = list.find((m) => m.id === id);
      if (match === undefined) throw new McpError('response did not include a message for this request');
      return match;
    }

    for (const event of raw.split('\n\n')) {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data === '') continue;
      try {
        const message = JSON.parse(data) as JsonRpcMessage;
        if (message.id === id) return message;
      } catch {
        // Non-JSON keep-alive data; skip.
      }
    }
    throw new McpError('SSE stream ended without a response for this request');
  }
}
