import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoveryEndpoint, isPidAlive, readCredentialsToken, readDiscovery, resolveTarget } from './discovery';
import { makeHome, runningDiscovery } from './testing/stdioHarness';

const alive = () => true;

describe('readDiscovery / readCredentialsToken', () => {
  it('reads the fields the app writes and the token the CLI saves', () => {
    const home = makeHome({ discovery: runningDiscovery(14507), token: '  tok_abc  ' });
    expect(readDiscovery(home)).toEqual({ pid: process.pid, port: 14507, endpoint: 'http://127.0.0.1:14507/mcp', mcpEnabled: true, version: '1.5.5' });
    expect(readCredentialsToken(home)).toBe('tok_abc');
  });

  it('treats missing, malformed or empty files as absent', () => {
    const home = makeHome({});
    expect(readDiscovery(home)).toBeNull();
    expect(readCredentialsToken(home)).toBeNull();
    fs.writeFileSync(path.join(home, '.jamsql', 'mcp-discovery.json'), '{ not json');
    fs.writeFileSync(path.join(home, '.jamsql', 'credentials'), JSON.stringify({ token: '' }));
    expect(readDiscovery(home)).toBeNull();
    expect(readCredentialsToken(home)).toBeNull();
    fs.writeFileSync(path.join(home, '.jamsql', 'mcp-discovery.json'), JSON.stringify({ port: 1 }));
    expect(readDiscovery(home)).toBeNull();
  });

  it('builds the endpoint from the port when the file has none (the CLI fallback)', () => {
    expect(discoveryEndpoint({ pid: 1, port: 15000, endpoint: null, mcpEnabled: true, version: null })).toBe('http://127.0.0.1:15000/mcp');
    expect(discoveryEndpoint({ pid: 1, port: null, endpoint: null, mcpEnabled: false, version: null })).toBeNull();
  });
});

describe('isPidAlive', () => {
  it('is true for this process and false for nonsense or exited pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('resolveTarget', () => {
  it('uses discovery + credentials by default', () => {
    const home = makeHome({ discovery: runningDiscovery(14507), token: 'tok' });
    expect(resolveTarget({ env: {}, homeDir: home, pidAlive: alive })).toEqual({
      ok: true,
      target: { endpoint: 'http://127.0.0.1:14507/mcp', token: 'tok', source: 'discovery', appVersion: '1.5.5' },
    });
  });

  it('lets the env override both, accepting a pasted "Bearer " prefix and the CLI variable names', () => {
    const home = makeHome({ discovery: runningDiscovery(14507), token: 'file-token' });
    const env = { JAMSQL_MCP_URL: 'http://127.0.0.1:9999/mcp', JAMSQL_MCP_TOKEN: 'Bearer env-token' };
    expect(resolveTarget({ env, homeDir: home, pidAlive: alive })).toMatchObject({ ok: true, target: { endpoint: 'http://127.0.0.1:9999/mcp', token: 'env-token', source: 'env' } });
    const cliEnv = { JAM_SQL_MCP_ENDPOINT: 'http://localhost:9000/mcp', JAM_SQL_MCP_TOKEN: 'cli-token' };
    expect(resolveTarget({ env: cliEnv, homeDir: makeHome({}) })).toMatchObject({ ok: true, target: { endpoint: 'http://localhost:9000/mcp', token: 'cli-token' } });
  });

  it('reports app state before pairing: not running, then disabled, then not paired', () => {
    const reason = (home: string, pidAlive = alive) => {
      const result = resolveTarget({ env: {}, homeDir: home, pidAlive });
      return result.ok ? 'ok' : result.failure.reason;
    };
    expect(reason(makeHome({}))).toBe('app-not-running');
    expect(reason(makeHome({ discovery: runningDiscovery(1), token: 't' }), () => false)).toBe('app-not-running');
    expect(reason(makeHome({ discovery: { ...runningDiscovery(1), mcpEnabled: false, port: null, endpoint: null } }))).toBe('mcp-disabled');
    expect(reason(makeHome({ discovery: runningDiscovery(14507) }))).toBe('not-paired');
  });

  it('refuses to send the token to a non-local discovery endpoint, and rejects a non-http override', () => {
    const remote = makeHome({ discovery: { ...runningDiscovery(1), endpoint: 'http://evil.example.com/mcp' }, token: 't' });
    expect(resolveTarget({ env: {}, homeDir: remote, pidAlive: alive })).toMatchObject({ ok: false, failure: { reason: 'invalid-config' } });
    const bad = resolveTarget({ env: { JAMSQL_MCP_URL: 'ftp://x' }, homeDir: makeHome({}) });
    expect(bad).toMatchObject({ ok: false, failure: { reason: 'invalid-config' } });
    expect(bad.ok ? '' : bad.failure.message).toContain('JAMSQL_MCP_URL');
  });
});
