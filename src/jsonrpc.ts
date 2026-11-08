/**
 * The little JSON-RPC 2.0 the bridge needs to understand: which incoming
 * messages are requests (they get an answer, also when the app cannot be
 * reached), and how to build an error answer. Everything else passes through
 * untouched.
 */

import { errorCodeFor, DOCS_URL, type BridgeFailure } from './messages';

export type JsonRpcId = string | number;

export type JsonRpcMessage = Record<string, unknown>;

/** One message or a batch, exactly as read from stdin. */
export type JsonRpcPayload = JsonRpcMessage | JsonRpcMessage[];

const isObject = (value: unknown): value is JsonRpcMessage =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isJsonRpcPayload = (value: unknown): value is JsonRpcPayload =>
  isObject(value) || (Array.isArray(value) && value.length > 0 && value.every(isObject));

const isId = (value: unknown): value is JsonRpcId => typeof value === 'string' || typeof value === 'number';

/** A request carries a method and an id; notifications and responses get no answer. */
export const isRequest = (message: JsonRpcMessage): boolean =>
  typeof message.method === 'string' && isId(message.id);

export const isInitialize = (payload: JsonRpcPayload): payload is JsonRpcMessage =>
  !Array.isArray(payload) && payload.method === 'initialize' && isRequest(payload);

export const asList = (payload: JsonRpcPayload): JsonRpcMessage[] => (Array.isArray(payload) ? payload : [payload]);

/** Ids of the requests in a payload — the answers the client is waiting for. */
export const requestIds = (payload: JsonRpcPayload): JsonRpcId[] =>
  asList(payload)
    .filter(isRequest)
    .map((message) => message.id as JsonRpcId);

/** A response (result or error) for one of `ids`. */
export const isResponseTo = (message: unknown, ids: readonly JsonRpcId[]): boolean =>
  isObject(message) && typeof message.method !== 'string' && isId(message.id) && ids.includes(message.id);

export const isJsonRpcMessage = (value: unknown): value is JsonRpcMessage =>
  isObject(value) && (typeof value.method === 'string' || 'result' in value || 'error' in value);

export const errorResponse = (id: JsonRpcId | null, failure: BridgeFailure): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: errorCodeFor(failure.reason),
    message: failure.message,
    data: { reason: failure.reason, docs: DOCS_URL },
  },
});

export const parseErrorResponse = (): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id: null,
  error: { code: -32700, message: 'Parse error: each stdin line must be one JSON-RPC message.' },
});

/**
 * The app's answer to a non-initialize request on a session it no longer
 * knows (it restarted, or its MCP server was switched off and on): a 200
 * JSON "result" with `isError` and this text — electron/mcpServer.ts. The
 * bridge re-initializes on it instead of passing it to the client.
 */
export const isAppSessionExpiredAnswer = (messages: readonly unknown[]): boolean => {
  if (messages.length !== 1 || !isObject(messages[0])) return false;
  const result = messages[0].result;
  if (!isObject(result) || result.isError !== true || !Array.isArray(result.content)) return false;
  const first: unknown = result.content[0];
  return isObject(first) && typeof first.text === 'string' && first.text.startsWith('MCP session expired');
};

/** The negotiated protocol version from an initialize result, if this is one. */
export const protocolVersionOf = (message: unknown): string | null => {
  if (!isObject(message) || !isObject(message.result)) return null;
  const version = message.result.protocolVersion;
  return typeof version === 'string' && version !== '' ? version : null;
};

/** Method names only (no params: they can hold SQL) — for JAMSQL_MCP_DEBUG logging. */
export const describePayload = (payload: JsonRpcPayload): string =>
  asList(payload)
    .map((message) => (typeof message.method === 'string' ? message.method : 'response'))
    .join(', ');
