/**
 * stderr logging for the bridge. stdout carries only JSON-RPC, so every human
 * line goes here, prefixed `jamsql-mcp:`. Any registered secret (the bearer
 * token) is replaced before a line is written, so a message that somehow
 * picked up the token still cannot print it.
 */

export type Logger = {
  info: (message: string) => void;
  /** Written only with JAMSQL_MCP_DEBUG=1. */
  debug: (message: string) => void;
  addSecret: (secret: string) => void;
};

export const REDACTED = '[redacted]';

export const createLogger = (output: NodeJS.WritableStream, debugEnabled: boolean): Logger => {
  const secrets = new Set<string>();

  const redact = (message: string): string => {
    let safe = message;
    for (const secret of secrets) safe = safe.split(secret).join(REDACTED);
    return safe;
  };

  const write = (message: string): void => {
    output.write(`jamsql-mcp: ${redact(message)}\n`);
  };

  return {
    info: write,
    debug: (message) => {
      if (debugEnabled) write(message);
    },
    addSecret: (secret) => {
      if (secret.length >= 4) secrets.add(secret);
    },
  };
};
