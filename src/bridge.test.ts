import { afterEach, describe, expect, it } from 'vitest';
import { startFakeAppServer, type FakeAppServer } from './testing/fakeAppServer';
import { INIT_PARAMS, makeHome, runningDiscovery, startHarness, writeHome, type Harness } from './testing/stdioHarness';

const TOKEN = 'tok_8f3a91c2d4e5b6a7';

let server: FakeAppServer | null = null;
let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    // The bearer token never reaches stderr or stdout, whatever happened in the test.
    expect(harness.stderr()).not.toContain(TOKEN);
    expect(JSON.stringify(harness.messages)).not.toContain(TOKEN);
    await harness.end();
  }
  await server?.close();
  harness = null;
  server = null;
});

const connect = async (): Promise<{ server: FakeAppServer; harness: Harness; home: string }> => {
  server = await startFakeAppServer(TOKEN);
  const home = makeHome({ discovery: runningDiscovery(server.port()), token: TOKEN });
  harness = startHarness({ homeDir: home });
  const init = await harness.request(1, 'initialize', INIT_PARAMS);
  expect(init).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sql-studio' } } });
  harness.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { server, harness, home };
};

const toolCall = (h: Harness, id: number, name: string) => h.request(id, 'tools/call', { name, arguments: {} });

describe('bridge — forwarding', () => {
  it('forwards initialize, tools/list and tools/call over the session the app created', async () => {
    const { server: app, harness: h } = await connect();
    expect(await h.request(2, 'tools/list')).toMatchObject({ result: { tools: [{ name: 'connections_list' }, { name: 'query_execute' }] } });
    expect(await toolCall(h, 3, 'connections_list')).toMatchObject({ result: { content: [{ text: 'connections_list ran' }] } });

    const [init, ...rest] = app.requests.filter((r) => r.method === 'POST');
    expect(init).toMatchObject({ rpcMethod: 'initialize', sessionId: null, protocolVersion: null, authorized: true });
    for (const request of rest) expect(request).toMatchObject({ sessionId: 'session-1', protocolVersion: '2025-06-18' });
    expect(rest.map((r) => r.rpcMethod)).toEqual(['notifications/initialized', 'tools/list', 'tools/call']);
    // Every request says it came through the bridge (the app's `via` analytics property).
    for (const request of [init, ...rest]) expect(request.via).toBe('npm-bridge');
    // The 202 for the notification writes nothing to stdout.
    expect(h.messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('passes server notifications on before the answer, and handles JSON answers', async () => {
    const { server: app, harness: h } = await connect();
    app.toolAnswers.set('query_execute', 'progress-then-ok');
    await toolCall(h, 2, 'query_execute');
    expect(h.messages.slice(-2).map((m) => m.method ?? m.id)).toEqual(['notifications/progress', 2]);

    app.answerAs = 'json';
    expect(await h.request(3, 'tools/list')).toMatchObject({ result: { tools: [{ name: 'connections_list' }, { name: 'query_execute' }] } });
  });

  it('answers a line that is not JSON, or not a JSON-RPC message, with an error', async () => {
    const { harness: h } = await connect();
    const errorCode = (m: Record<string, unknown>) => (m.error as { code?: number } | undefined)?.code;
    h.sendRaw('not json');
    await h.waitFor((m) => m.id === null && errorCode(m) === -32700);
    h.sendRaw('"just a string"');
    await h.waitFor((m) => m.id === null && errorCode(m) === -32600);
  });
});

describe('bridge — app restarts', () => {
  it('reconnects transparently after the app drops every session on the same port', async () => {
    const { server: app, harness: h } = await connect();
    await app.restart();
    expect(await toolCall(h, 2, 'connections_list')).toMatchObject({ id: 2, result: { content: [{ text: 'connections_list ran' }] } });
    expect(app.requests.filter((r) => r.rpcMethod === 'initialize')).toHaveLength(2);
    expect(h.stderr()).toContain('Reconnected to Jam SQL Studio');
    expect(h.messages.filter((m) => m.id === 2)).toHaveLength(1);
  });

  it('follows the app to a new port by re-reading the discovery file', async () => {
    const { server: app, harness: h, home } = await connect();
    const oldPort = app.port();
    await app.restart({ newPort: true });
    expect(app.port()).not.toBe(oldPort);
    writeHome(home, { discovery: runningDiscovery(app.port()) });
    expect(await toolCall(h, 2, 'connections_list')).toMatchObject({ result: { content: [{ text: 'connections_list ran' }] } });
    expect(app.requests.find((r) => r.rpcMethod === 'tools/call')).toMatchObject({ sessionId: 'session-2' });
  });

  it('never retries a request that reached the app; reports the lost answer', async () => {
    const { server: app, harness: h } = await connect();
    app.toolAnswers.set('query_execute', 'drop-stream');
    expect(await toolCall(h, 2, 'query_execute')).toMatchObject({ error: { code: -32007, data: { reason: 'connection-lost' } } });
    expect(app.requests.filter((r) => r.rpcMethod === 'tools/call')).toHaveLength(1);
  });

  it('re-reads the token once after a 401 and uses a re-paired token', async () => {
    const { server: app, harness: h, home } = await connect();
    app.token = `${TOKEN}-rotated`;
    writeHome(home, { token: `${TOKEN}-rotated` });
    expect(await toolCall(h, 2, 'connections_list')).toMatchObject({ result: { content: [{ text: 'connections_list ran' }] } });
    expect(h.stderr()).not.toContain(`${TOKEN}-rotated`);
  });
});

describe('bridge — actionable failures', () => {
  const failingInitialize = async (home: string, pidAlive?: (pid: number) => boolean) => {
    harness = startHarness({ homeDir: home, pidAlive });
    return harness.request(1, 'initialize', INIT_PARAMS);
  };

  it('says the app is not running when there is no discovery file, or its pid is dead', async () => {
    const none = await failingInitialize(makeHome({ token: TOKEN }));
    expect(none).toMatchObject({ error: { code: -32001, data: { reason: 'app-not-running' } } });
    expect(String((none.error as { message: string }).message)).toContain('https://jamsql.com/docs/ai-integrations-mcp/#stdio-bridge');
    expect(harness!.stderr()).toContain('Jam SQL Studio is not running');
    await harness!.end();

    const stale = await failingInitialize(makeHome({ discovery: runningDiscovery(1), token: TOKEN }), () => false);
    expect(stale).toMatchObject({ error: { data: { reason: 'app-not-running' } } });
  });

  it('says the MCP server is off when the app runs with it disabled', async () => {
    const discovery = { ...runningDiscovery(1), port: null, endpoint: null, mcpEnabled: false };
    expect(await failingInitialize(makeHome({ discovery, token: TOKEN }))).toMatchObject({ error: { code: -32002 } });
    expect(harness!.stderr()).toContain('Settings → AI Integrations → Enable MCP server');
  });

  it('tells an unpaired user to run jam-sql pair', async () => {
    server = await startFakeAppServer(TOKEN);
    expect(await failingInitialize(makeHome({ discovery: runningDiscovery(server.port()) }))).toMatchObject({ error: { code: -32003 } });
    expect(harness!.stderr()).toContain('jam-sql pair');
  });

  it('reports a rejected token without printing it', async () => {
    server = await startFakeAppServer('a-different-token');
    const answer = await failingInitialize(makeHome({ discovery: runningDiscovery(server.port()), token: TOKEN }));
    expect(answer).toMatchObject({ error: { code: -32004, data: { reason: 'token-rejected' } } });
  });

  it('uses JAMSQL_MCP_URL and JAMSQL_MCP_TOKEN without any ~/.jamsql files', async () => {
    server = await startFakeAppServer(TOKEN);
    harness = startHarness({ homeDir: makeHome({}), env: { JAMSQL_MCP_URL: server.endpoint(), JAMSQL_MCP_TOKEN: `Bearer ${TOKEN}` } });
    expect(await harness.request(1, 'initialize', INIT_PARAMS)).toMatchObject({ result: { serverInfo: { name: 'sql-studio' } } });
  });

  it('closes the app session when stdin ends', async () => {
    const { server: app, harness: h } = await connect();
    await h.end();
    harness = null;
    expect(app.requests.at(-1)).toMatchObject({ method: 'DELETE', sessionId: 'session-1' });
  });
});
