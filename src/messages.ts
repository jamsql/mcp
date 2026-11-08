/**
 * Everything the bridge tells a person: the failure reasons, their stderr /
 * JSON-RPC wording and error codes. Each message links the setup docs. None
 * of them ever contains the bearer token.
 */

export const BRIDGE_VERSION = '1.0.1';

export const DOCS_URL = 'https://jamsql.com/docs/ai-integrations-mcp/#stdio-bridge';

export type FailureReason =
  | 'app-not-running'
  | 'mcp-disabled'
  | 'not-paired'
  | 'token-rejected'
  | 'invalid-config'
  | 'unreachable'
  | 'connection-lost'
  | 'http-error';

export type BridgeFailure = {
  reason: FailureReason;
  message: string;
};

/** JSON-RPC implementation-defined server errors (-32000..-32099), one per reason. */
const ERROR_CODES: Record<FailureReason, number> = {
  'app-not-running': -32001,
  'mcp-disabled': -32002,
  'not-paired': -32003,
  'token-rejected': -32004,
  'invalid-config': -32005,
  unreachable: -32006,
  'connection-lost': -32007,
  'http-error': -32008,
};

export const errorCodeFor = (reason: FailureReason): number => ERROR_CODES[reason];

const withDocs = (text: string): string => `${text} Setup and troubleshooting: ${DOCS_URL}`;

export const appNotRunning = (): BridgeFailure => ({
  reason: 'app-not-running',
  message: withDocs('Jam SQL Studio is not running. Start the app and keep it open while your AI tool uses it.'),
});

export const mcpDisabled = (): BridgeFailure => ({
  reason: 'mcp-disabled',
  message: withDocs(
    'Jam SQL Studio is running, but its MCP server is turned off. Turn it on in Settings → AI Integrations → Enable MCP server.',
  ),
});

export const notPaired = (): BridgeFailure => ({
  reason: 'not-paired',
  message: withDocs(
    'Not paired with Jam SQL Studio: no token in ~/.jamsql/credentials. Run `jam-sql pair` in a terminal, or set JAMSQL_MCP_TOKEN to the token from Settings → AI Integrations.',
  ),
});

export const tokenRejected = (): BridgeFailure => ({
  reason: 'token-rejected',
  message: withDocs(
    'Jam SQL Studio rejected the pairing token (it may have been regenerated). Run `jam-sql pair` again, or update JAMSQL_MCP_TOKEN.',
  ),
});

export const invalidConfig = (detail: string): BridgeFailure => ({
  reason: 'invalid-config',
  message: withDocs(detail),
});

export const unreachable = (endpoint: string, code: string): BridgeFailure => ({
  reason: 'unreachable',
  message: withDocs(
    `Could not reach Jam SQL Studio's MCP server at ${endpoint} (${code}). Check that the app is running and its MCP server is enabled.`,
  ),
});

export const connectionLost = (): BridgeFailure => ({
  reason: 'connection-lost',
  message: withDocs(
    'Jam SQL Studio closed the connection before answering (the app or its MCP server may have restarted). Try again.',
  ),
});

export const httpError = (status: number, detail: string): BridgeFailure => ({
  reason: 'http-error',
  message: withDocs(`Jam SQL Studio answered HTTP ${status}${detail ? `: ${detail}` : ''}.`),
});
