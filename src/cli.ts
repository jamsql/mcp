#!/usr/bin/env node
/**
 * `jamsql-mcp` — lets stdio-only MCP clients (Claude Desktop, or any client
 * started with `npx -y @jamsql/mcp`) use Jam SQL Studio's local MCP server.
 * Zero configuration: the endpoint and token come from `~/.jamsql`, exactly
 * as the `jam-sql` CLI finds them. Runs on Node 18+.
 */

import * as os from 'node:os';
import { runBridge } from './bridge';
import { BRIDGE_VERSION, DOCS_URL } from './messages';

const USAGE = `jamsql-mcp ${BRIDGE_VERSION}
Connects a stdio MCP client to Jam SQL Studio's local MCP server.

Usage: npx -y @jamsql/mcp

Run it from your MCP client's configuration; it speaks JSON-RPC on stdin/stdout.
It finds the running app through ~/.jamsql/mcp-discovery.json and the token
saved by \`jam-sql pair\` in ~/.jamsql/credentials.

Environment (optional):
  JAMSQL_MCP_URL     MCP endpoint, e.g. http://127.0.0.1:14507/mcp
  JAMSQL_MCP_TOKEN   Bearer token from Settings → AI Integrations
  JAMSQL_MCP_DEBUG   1 = log each forwarded method to stderr

Docs: ${DOCS_URL}
`;

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${BRIDGE_VERSION}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.length > 0) {
    process.stderr.write(`jamsql-mcp: unknown argument ${args[0]}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // A client that goes away leaves stdout broken; there is nobody left to answer.
  process.stdout.on('error', () => process.exit(0));

  const bridge = runBridge({
    env: process.env,
    homeDir: os.homedir(),
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
  });

  const shutdown = (): void => {
    void bridge.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  void bridge.finished.then(() => process.exit(0));
};

main();
