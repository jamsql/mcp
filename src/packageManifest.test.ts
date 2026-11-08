/**
 * The published shape: package.json, server.json (MCP Registry) and the
 * version the bridge reports must agree, and stay within the registry
 * schema's limits (schemas/2025-12-11/server.schema.json).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIDGE_VERSION } from './messages';

const root = path.resolve(__dirname, '..');
const readJson = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

const pkg = readJson('package.json');
const server = readJson('server.json') as {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  packages: Array<{ registryType: string; identifier: string; version: string; transport: { type: string }; environmentVariables: Array<{ name: string; isSecret?: boolean }> }>;
};

describe('package.json', () => {
  it('publishes as @jamsql/mcp with the jamsql-mcp bin, on Node 18+', () => {
    expect(pkg).toMatchObject({
      name: '@jamsql/mcp',
      bin: { 'jamsql-mcp': 'dist/cli.js' },
      engines: { node: '>=18' },
      homepage: 'https://jamsql.com/docs/ai-integrations-mcp/',
      author: 'Jam SQL Studio <support@jamsql.com>',
    });
    expect(pkg.files).toEqual(['dist/**/*.js', '!dist/**/*.test.js']);
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/jamsql/mcp.git' });
    expect(pkg).not.toHaveProperty('dependencies');
  });

  it('is MIT-licensed by Jam SQL Studio, with the license text shipped beside it', () => {
    expect(pkg.license).toBe('MIT');
    const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
    expect(license.startsWith('MIT License')).toBe(true);
    expect(license).toContain('Copyright (c) 2026 Jam SQL Studio');
  });

  it('claims the registry name (npm ownership proof) and reports its own version', () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(pkg.version).toBe(BRIDGE_VERSION);
  });
});

describe('server.json', () => {
  it('names the npm package over stdio at the same version', () => {
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.name.startsWith('com.jamsql/')).toBe(true);
    expect(server.version).toBe(pkg.version);
    expect(server.websiteUrl).toBe('https://jamsql.com/');
    expect((server as { repository?: unknown }).repository).toEqual({ url: 'https://github.com/jamsql/mcp', source: 'github' });
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } });
  });

  it('stays within the schema limits and marks the token secret', () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
    const env = Object.fromEntries(server.packages[0].environmentVariables.map((v) => [v.name, v]));
    expect(env.JAMSQL_MCP_TOKEN.isSecret).toBe(true);
    expect(env.JAMSQL_MCP_URL.isSecret).toBe(false);
  });
});
