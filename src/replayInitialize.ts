/**
 * Opens a fresh MCP session for a client that is already initialized: sends
 * the client's own `initialize` params again (under a bridge-private id the
 * client never sees), then `notifications/initialized`. Used after the app
 * restarted or switched its MCP server off and on, which drops every session.
 */

import { exchange, type ExchangeResult } from './httpTransport';
import type { Target } from './discovery';
import { protocolVersionOf } from './jsonrpc';

export type ReplayOutcome =
  | { ok: true; sessionId: string | null; protocolVersion: string }
  | { ok: false; result: ExchangeResult };

export const replayInitialize = async (target: Target, params: unknown, id: string): Promise<ReplayOutcome> => {
  const { endpoint, token } = target;
  let version: string | null = null;
  const result = await exchange({
    endpoint,
    token,
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params }),
    onStreamMessage: (message) => {
      version = protocolVersionOf(message) ?? version;
    },
  });
  if (result.kind === 'json') version = result.messages.map(protocolVersionOf).find((v) => v !== null) ?? null;
  if ((result.kind !== 'json' && result.kind !== 'stream') || !version) return { ok: false, result };

  await exchange({
    endpoint,
    token,
    sessionId: result.sessionId ?? undefined,
    protocolVersion: version,
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return { ok: true, sessionId: result.sessionId, protocolVersion: version };
};
