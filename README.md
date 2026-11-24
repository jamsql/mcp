# @jamsql/mcp

[![jamsql/mcp MCP server](https://glama.ai/mcp/servers/jamsql/mcp/badges/score.svg)](https://glama.ai/mcp/servers/jamsql/mcp)

Connects stdio MCP clients (Claude Desktop, Cursor, VS Code, and any client you configure with `npx`) to the local MCP server inside the [Jam SQL Studio](https://jamsql.com/) desktop app. Your AI tool can then list your saved connections and query SQL Server, PostgreSQL, MySQL/MariaDB, Oracle and SQLite under the permission level you set in the app.

The package forwards MCP messages between the client's stdin/stdout and the app's `http://127.0.0.1:<port>/mcp` endpoint. It finds the endpoint and the token on its own, the same way the `jam-sql` CLI does, so the client configuration contains no port and no token.

Full documentation: <https://jamsql.com/docs/ai-integrations-mcp/#stdio-bridge>

Jam SQL Studio: [website](https://jamsql.com/) · [download](https://jamsql.com/download/) · [documentation](https://jamsql.com/docs/) · [pricing](https://jamsql.com/pricing/)

## What your AI tool can do through it

The tools come from the app, so they match the app version you run:

- **Connections:** list the saved connections without their credentials (`connections_list`), open one (`connections_connect`, which asks you first by default), and, if you allow it in the app, add a new one (`connections_add`).
- **Queries:** run SQL and get the rows back (`query_execute`), or run it in a query tab so you see the results in the app (`ui_execute_query`); read execution plans and messages.
- **Schema:** tables, views, procedures, functions, columns, indexes, constraints and dependencies (`schema_*`).
- **The app's UI:** open, focus and close tabs, filter and sort Table Explorer, show charts and row details (`ui_*`, `table_*`, `query_*`).
- **Compare:** schema compare and data compare, including the generated scripts (`schema_compare_*`, `data_compare_*`).
- **Notebooks and Azure Storage:** edit and run SQL notebook cells (`notebook_*`); browse and change blobs, files, queues and tables (`storage_*`).

## Permissions and approvals

Your AI tool never receives connection credentials: the app keeps them and runs every query itself. Each connection has an AI permission level that you set in the app:

- **Block** (the default): no query runs. The agent can still read the schema and put SQL into a query tab.
- **Read-only**: reads run (`SELECT`, `EXPLAIN`, `SHOW`, `PRAGMA`, SQL Server's read-only system procedures).
- **Confirm**: each write waits for your approval in Jam SQL Studio's window, which shows the whole SQL and, for most `UPDATE` and `DELETE` statements, how many rows it affects.

## Requirements

- Jam SQL Studio running, with **Settings → AI Integrations → Enable MCP server** turned on.
- Paired once with `jam-sql pair` (the `jam-sql` CLI ships with the app and is installed on your PATH). Pairing stores the token in `~/.jamsql/credentials`.
- Node.js 18 or newer, with `npx` available.

## Setup

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "jam-sql": {
      "command": "npx",
      "args": ["-y", "@jamsql/mcp"]
    }
  }
}
```

Quit and reopen Claude Desktop. Jam SQL Studio 1.5.9 and later can add this entry for you: **Settings → AI Integrations → Quick Setup → Add to Claude Desktop**.

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "jam-sql": {
      "command": "npx",
      "args": ["-y", "@jamsql/mcp"]
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "jam-sql": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@jamsql/mcp"]
    }
  }
}
```

Cursor and VS Code can also connect to the app's HTTP endpoint directly. The `npx` entry above needs no endpoint or token in the file and keeps working when the app's port changes.

### Without `jam-sql pair`

Set the endpoint and the token from **Settings → AI Integrations** in the client's `env` block instead:

```json
{
  "mcpServers": {
    "jam-sql": {
      "command": "npx",
      "args": ["-y", "@jamsql/mcp"],
      "env": {
        "JAMSQL_MCP_URL": "http://127.0.0.1:14507/mcp",
        "JAMSQL_MCP_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

| Variable | Default |
|---|---|
| `JAMSQL_MCP_URL` | Read from `~/.jamsql/mcp-discovery.json`, which the app writes on start |
| `JAMSQL_MCP_TOKEN` | Read from `~/.jamsql/credentials`, which `jam-sql pair` writes |
| `JAMSQL_MCP_DEBUG` | Set to `1` to log each forwarded method name to stderr |

The `jam-sql` CLI's variable names `JAM_SQL_MCP_ENDPOINT` and `JAM_SQL_MCP_TOKEN` are accepted too.

## What happens when the app restarts

The app's MCP sessions end when the app restarts or its MCP server is switched off and on. The bridge notices, opens a new session with the client's original `initialize` parameters and retries the request, so the client keeps working without a restart. If the app comes back on a different port, the bridge reads the new port from the discovery file. A request that already reached the app is never sent twice; if its answer is lost, the client gets an error instead.

## Troubleshooting

The bridge writes its messages to stderr, which your client keeps in its MCP log (Claude Desktop: `~/Library/Logs/Claude/` on macOS, `%APPDATA%\Claude\logs\` on Windows). Requests that cannot be forwarded are answered with a JSON-RPC error carrying the same message. The token is never printed.

| Message | What to do |
|---|---|
| Jam SQL Studio is not running | Start the app and keep it open. |
| Its MCP server is turned off | Settings → AI Integrations → Enable MCP server. |
| Not paired with Jam SQL Studio | Run `jam-sql pair`, or set `JAMSQL_MCP_TOKEN`. |
| Rejected the pairing token | The token was regenerated in the app. Run `jam-sql pair` again, or update `JAMSQL_MCP_TOKEN`. |
| Could not reach Jam SQL Studio's MCP server | Check `JAMSQL_MCP_URL`, or that the app's MCP server is enabled. |

Check the bridge from a terminal:

```sh
npx -y @jamsql/mcp --version
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"terminal","version":"0"}}}' | npx -y @jamsql/mcp
```

The second command prints the app's `initialize` answer when everything is set up, or the error that says what is missing.

On Windows, if the client cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@jamsql/mcp"]`.

## Building from source

```sh
npm install
npm run build      # compiles src/ to dist/
npm test           # unit tests (vitest)
npm run typecheck
```

The published package is built the same way; it has no runtime dependencies.

## Support

support@jamsql.com

## License

MIT — see [LICENSE](LICENSE). The package is a client for the Jam SQL Studio desktop app, which has its own license.
