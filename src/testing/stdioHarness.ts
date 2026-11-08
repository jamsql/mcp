/**
 * TEST-ONLY: runs the bridge in-process on in-memory stdio streams, plus a
 * temporary home directory holding `~/.jamsql` the way the app and the
 * `jam-sql` CLI write it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { runBridge } from '../bridge';
import type { BridgeEnv } from '../discovery';

export type RpcMessage = Record<string, unknown> & { id?: string | number | null; method?: string };

export type Harness = {
  send: (message: unknown) => void;
  /** Writes one line to stdin as-is. */
  sendRaw: (line: string) => void;
  request: (id: string | number, method: string, params?: Record<string, unknown>) => Promise<RpcMessage>;
  waitFor: (predicate: (message: RpcMessage) => boolean) => Promise<RpcMessage>;
  messages: RpcMessage[];
  stderr: () => string;
  /** Closes stdin and waits for the bridge to drain and close its session. */
  end: () => Promise<void>;
};

const WAIT_MS = 2000;

export const INIT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest-client', version: '1.0.0' } };

export const startHarness = (options: { env?: BridgeEnv; homeDir: string; pidAlive?: (pid: number) => boolean }): Harness => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const messages: RpcMessage[] = [];
  const waiters: Array<{ predicate: (message: RpcMessage) => boolean; done: (message: RpcMessage) => void }> = [];
  let stderr = '';
  let pending = '';

  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const message = JSON.parse(pending.slice(0, newline)) as RpcMessage;
      pending = pending.slice(newline + 1);
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.done(message);
        }
      }
      newline = pending.indexOf('\n');
    }
  });
  errorOutput.setEncoding('utf8');
  errorOutput.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const bridge = runBridge({
    env: options.env ?? {},
    homeDir: options.homeDir,
    input,
    output,
    errorOutput,
    pidAlive: options.pidAlive ?? (() => true),
    retryDelaysMs: [20, 40, 80],
    drainTimeoutMs: 500,
  });

  const waitFor: Harness['waitFor'] = (predicate) => {
    const seen = messages.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no matching stdout message; stderr:\n${stderr}`)), WAIT_MS);
      waiters.push({ predicate, done: (message) => (clearTimeout(timer), done(message)) });
    });
  };

  const send: Harness['send'] = (message) => {
    input.write(`${JSON.stringify(message)}\n`);
  };

  return {
    send,
    sendRaw: (line) => {
      input.write(`${line}\n`);
    },
    request: (id, method, params) => {
      send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      return waitFor((message) => message.id === id && message.method === undefined);
    },
    waitFor,
    messages,
    stderr: () => stderr,
    end: async () => {
      input.end();
      await bridge.finished;
    },
  };
};

export type HomeFixture = {
  discovery?: Record<string, unknown> | null;
  token?: string | null;
};

/** A temporary home with `.jamsql/mcp-discovery.json` and `.jamsql/credentials` as given. */
export const makeHome = (fixture: HomeFixture): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jamsql-mcp-home-'));
  writeHome(home, fixture);
  return home;
};

export const writeHome = (home: string, fixture: HomeFixture): void => {
  const dir = path.join(home, '.jamsql');
  fs.mkdirSync(dir, { recursive: true });
  const discoveryPath = path.join(dir, 'mcp-discovery.json');
  const credentialsPath = path.join(dir, 'credentials');
  if (fixture.discovery === null) fs.rmSync(discoveryPath, { force: true });
  else if (fixture.discovery) fs.writeFileSync(discoveryPath, JSON.stringify(fixture.discovery, null, 2));
  if (fixture.token === null) fs.rmSync(credentialsPath, { force: true });
  else if (fixture.token !== undefined) {
    const credentials = { token: fixture.token, pairedAt: '2026-10-10T00:00:00Z', appVersion: '1.5.5' };
    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  }
};

/** The discovery file the app writes while its MCP server listens on `port`. */
export const runningDiscovery = (port: number): Record<string, unknown> => ({
  pid: process.pid,
  port,
  endpoint: `http://127.0.0.1:${port}/mcp`,
  pairingEndpoint: `http://127.0.0.1:${port}/pair`,
  statusEndpoint: `http://127.0.0.1:${port}/status`,
  mcpEnabled: true,
  startedAt: '2026-10-10T00:00:00.000Z',
  version: '1.5.5',
});
