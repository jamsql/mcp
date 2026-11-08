/**
 * One MCP streamable-HTTP exchange with the app: POST a JSON-RPC payload and
 * read the answer, which is a 202 (notification/response accepted), a JSON
 * body, or an SSE stream whose messages are handed over as they arrive.
 *
 * Built on node:http rather than fetch: fetch prints an ExperimentalWarning on
 * Node 18 (what Claude Desktop ships), and node:http streams SSE without a
 * dependency. Never logs or returns the Authorization header.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { createSseParser } from './sse';

export type ExchangeRequest = {
  endpoint: string;
  token: string;
  sessionId?: string;
  protocolVersion?: string;
  method: 'POST' | 'DELETE';
  body?: string;
  /** Each message of an SSE answer, in order, as soon as it is complete. */
  onStreamMessage?: (message: unknown) => void;
  connectTimeoutMs?: number;
};

export type ExchangeResult =
  | { kind: 'accepted'; status: number; sessionId: string | null }
  | { kind: 'json'; status: number; sessionId: string | null; messages: unknown[] }
  | { kind: 'stream'; status: number; sessionId: string | null; streamed: number }
  | { kind: 'http-error'; status: number; sessionId: string | null; detail: string }
  /** `connected: false` means the request never reached the app — safe to retry. */
  | { kind: 'network-error'; code: string; connected: boolean };

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const MAX_ERROR_DETAIL = 300;

const parseJsonMessages = (text: string): unknown[] | null => {
  if (text.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
};

/** A short, readable reason from an error body: `{ error: "…" }`, a JSON-RPC error, or the text. */
const errorDetail = (text: string): string => {
  const messages = parseJsonMessages(text);
  const first = messages?.[0] as { error?: unknown } | undefined;
  if (first && typeof first.error === 'string') return first.error;
  if (first && first.error && typeof (first.error as { message?: unknown }).message === 'string') {
    return (first.error as { message: string }).message;
  }
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_DETAIL ? `${trimmed.slice(0, MAX_ERROR_DETAIL)}…` : trimmed;
};

const headerValue = (value: string | string[] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) || null;

export const exchange = (request: ExchangeRequest): Promise<ExchangeResult> =>
  new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const finish = (result: ExchangeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      resolve(result);
    };

    const url = new URL(request.endpoint);
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${request.token}`,
      // Lets the app tell bridged sessions from direct ones (its `via` analytics property; 1.0.1+).
      'X-Jam-Via': 'npm-bridge',
    };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    if (request.sessionId) headers['Mcp-Session-Id'] = request.sessionId;
    if (request.protocolVersion) headers['Mcp-Protocol-Version'] = request.protocolVersion;

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: request.method, headers, agent: false }, (res) => {
      const status = res.statusCode ?? 0;
      const sessionId = headerValue(res.headers['mcp-session-id']);
      const contentType = headerValue(res.headers['content-type']) ?? '';
      res.setEncoding('utf8');

      if (status >= 200 && status < 300 && contentType.includes('text/event-stream')) {
        let streamed = 0;
        const parser = createSseParser((event) => {
          if (event.event !== 'message' || event.data.trim() === '') return;
          try {
            const message: unknown = JSON.parse(event.data);
            streamed += 1;
            request.onStreamMessage?.(message);
          } catch {
            // A malformed event is skipped; the missing answer is reported by the caller.
          }
        });
        res.on('data', (chunk: string) => parser.feed(chunk));
        res.on('end', () => {
          parser.end();
          finish({ kind: 'stream', status, sessionId, streamed });
        });
        res.on('error', () => finish({ kind: 'stream', status, sessionId, streamed }));
        res.on('close', () => finish({ kind: 'stream', status, sessionId, streamed }));
        return;
      }

      let text = '';
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        if (status < 200 || status >= 300) {
          finish({ kind: 'http-error', status, sessionId, detail: errorDetail(text) });
          return;
        }
        if (status === 202 || text.trim() === '') {
          finish({ kind: 'accepted', status, sessionId });
          return;
        }
        const messages = parseJsonMessages(text);
        if (messages === null) finish({ kind: 'http-error', status, sessionId, detail: 'the answer was not JSON' });
        else finish({ kind: 'json', status, sessionId, messages });
      });
      res.on('error', () => finish({ kind: 'network-error', code: 'ECONNRESET', connected: true }));
    });

    const connectTimer = setTimeout(() => {
      if (!connected) {
        req.destroy();
        finish({ kind: 'network-error', code: 'ETIMEDOUT', connected: false });
      }
    }, request.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    req.on('socket', (socket) => {
      const markConnected = (): void => {
        connected = true;
        clearTimeout(connectTimer);
      };
      if (!socket.connecting) markConnected();
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', markConnected);
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      finish({ kind: 'network-error', code: error.code ?? 'ECONNRESET', connected });
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
