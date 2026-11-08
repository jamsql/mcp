/**
 * TEST-ONLY stand-in for the app's MCP endpoint (electron/mcpServer.ts),
 * reproducing what the bridge depends on: bearer auth (401), sessions created
 * by `initialize` and named in `Mcp-Session-Id`, SSE answers (or JSON when
 * `answerAs` is 'json'), 202 for notifications, the app's 200 "MCP session
 * expired" result for an unknown session, and DELETE. `restart()` drops every
 * session like an app restart, optionally on a new port.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

type Message = Record<string, unknown> & { id?: string | number; method?: string; params?: Record<string, unknown> };

export type RecordedRequest = {
  method: string;
  rpcMethod: string | null;
  sessionId: string | null;
  protocolVersion: string | null;
  authorized: boolean;
  /** The bridge's `X-Jam-Via` header (the app reads it as the session's `via`). */
  via: string | null;
};

export type FakeAppServer = {
  port: () => number;
  endpoint: () => string;
  requests: RecordedRequest[];
  /** Methods by name: 'tools/call' answers per tool via `toolAnswers`. */
  toolAnswers: Map<string, 'ok' | 'progress-then-ok' | 'drop-stream'>;
  answerAs: 'sse' | 'json';
  token: string;
  restart: (options?: { newPort?: boolean }) => Promise<void>;
  close: () => Promise<void>;
};

const PROTOCOL = '2025-06-18';

const readBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export const startFakeAppServer = async (token: string): Promise<FakeAppServer> => {
  let server: http.Server | null = null;
  let port = 0;
  let sessions = new Set<string>();
  let nextSession = 1;

  const state: FakeAppServer = {
    port: () => port,
    endpoint: () => `http://127.0.0.1:${port}/mcp`,
    requests: [],
    toolAnswers: new Map(),
    answerAs: 'sse',
    token,
    restart: async (options) => {
      await stop();
      sessions = new Set();
      await listen(options?.newPort ? 0 : port);
    },
    close: () => stop(),
  };

  const answer = (res: http.ServerResponse, headers: Record<string, string>, messages: Message[]): void => {
    if (state.answerAs === 'json') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages.length === 1 ? messages[0] : messages));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
    for (const message of messages) res.write(`event: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`);
    res.end();
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = req.method === 'POST' ? await readBody(req) : '';
    const message = body ? (JSON.parse(body) as Message) : null;
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? null;
    const authorized = req.headers.authorization === `Bearer ${state.token}`;
    state.requests.push({
      method: req.method ?? '',
      rpcMethod: message && !Array.isArray(message) && typeof message.method === 'string' ? message.method : null,
      sessionId,
      protocolVersion: (req.headers['mcp-protocol-version'] as string | undefined) ?? null,
      authorized,
      via: (req.headers['x-jam-via'] as string | undefined) ?? null,
    });
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (req.method === 'DELETE') {
      if (sessionId) sessions.delete(sessionId);
      res.writeHead(200).end();
      return;
    }
    if (!message) {
      res.writeHead(400).end();
      return;
    }
    if (message.method === 'initialize') {
      const id = `session-${nextSession++}`;
      sessions.add(id);
      const result = { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'sql-studio', version: 'test' } };
      answer(res, { 'mcp-session-id': id }, [{ jsonrpc: '2.0', id: message.id, result }]);
      return;
    }
    if (!sessionId || !sessions.has(sessionId)) {
      // The app's own wording for a session it no longer knows (electron/mcpServer.ts).
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const text = 'MCP session expired (Jam SQL was restarted). Please run /mcp and restart the Jam SQL connection, then try again.';
      res.end(JSON.stringify({ jsonrpc: '2.0', result: { content: [{ type: 'text', text }], isError: true }, id: message.id }));
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (message.method === 'tools/list') {
      answer(res, {}, [{ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'connections_list' }, { name: 'query_execute' }] } }]);
      return;
    }
    const tool = String(message.params?.name ?? '');
    const mode = state.toolAnswers.get(tool) ?? 'ok';
    const ok: Message = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${tool} ran` }] } };
    if (mode === 'drop-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': working\n\n');
      res.destroy();
      return;
    }
    const progress: Message = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } };
    answer(res, {}, mode === 'progress-then-ok' ? [progress, ok] : [ok]);
  };

  const listen = (wanted: number): Promise<void> =>
    new Promise((done) => {
      server = http.createServer((req, res) => void handle(req, res));
      server.listen(wanted, '127.0.0.1', () => {
        port = (server!.address() as AddressInfo).port;
        done();
      });
    });

  const stop = (): Promise<void> =>
    new Promise((done) => {
      if (!server) return done();
      server.closeAllConnections?.();
      server.close(() => done());
      server = null;
    });

  await listen(0);
  return state;
};
