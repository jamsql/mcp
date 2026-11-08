/**
 * Finds the running Jam SQL Studio MCP endpoint and the bearer token — the
 * same contract the Go `jam-sql` CLI uses (cli/jam-sql/internal/config):
 *
 *  - `~/.jamsql/mcp-discovery.json`, written by the app on start
 *    (electron/mcp-pairing/discovery.ts): `pid`, `endpoint`, `port`,
 *    `mcpEnabled`, `version`. A dead `pid` means a stale file.
 *  - `~/.jamsql/credentials`, written by `jam-sql pair`: `{ "token": … }`.
 *
 * Environment overrides win over both: `JAMSQL_MCP_URL` / `JAMSQL_MCP_TOKEN`,
 * plus the CLI's own names `JAM_SQL_MCP_ENDPOINT` / `JAM_SQL_MCP_TOKEN`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appNotRunning,
  invalidConfig,
  mcpDisabled,
  notPaired,
  type BridgeFailure,
} from './messages';

export type BridgeEnv = Record<string, string | undefined>;

export type DiscoveryInfo = {
  pid: number;
  port: number | null;
  endpoint: string | null;
  mcpEnabled: boolean;
  version: string | null;
};

export type Target = {
  endpoint: string;
  token: string;
  /** Where the endpoint came from — env overrides are never re-discovered. */
  source: 'env' | 'discovery';
  appVersion: string | null;
};

export type TargetResolution = { ok: true; target: Target } | { ok: false; failure: BridgeFailure };

export const URL_ENV_NAMES = ['JAMSQL_MCP_URL', 'JAM_SQL_MCP_ENDPOINT'] as const;
export const TOKEN_ENV_NAMES = ['JAMSQL_MCP_TOKEN', 'JAM_SQL_MCP_TOKEN'] as const;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const jamsqlDir = (homeDir: string): string => path.join(homeDir, '.jamsql');

const readJson = (filePath: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** The app's discovery file, or null when it is missing or unreadable. */
export const readDiscovery = (homeDir: string): DiscoveryInfo | null => {
  const raw = readJson(path.join(jamsqlDir(homeDir), 'mcp-discovery.json'));
  if (!raw || typeof raw.pid !== 'number') return null;
  return {
    pid: raw.pid,
    port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : null,
    endpoint: typeof raw.endpoint === 'string' && raw.endpoint !== '' ? raw.endpoint : null,
    mcpEnabled: raw.mcpEnabled === true,
    version: typeof raw.version === 'string' ? raw.version : null,
  };
};

/** The token `jam-sql pair` saved, or null. */
export const readCredentialsToken = (homeDir: string): string | null => {
  const raw = readJson(path.join(jamsqlDir(homeDir), 'credentials'));
  return raw && typeof raw.token === 'string' && raw.token.trim() !== '' ? raw.token.trim() : null;
};

/** Signal 0 checks existence; EPERM means the process exists but is not ours. */
export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const firstEnv = (env: BridgeEnv, names: readonly string[]): { name: string; value: string } | null => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
};

/** Accepts a pasted "Bearer xyz" as well as the bare token. */
const normalizeToken = (value: string): string => value.replace(/^Bearer\s+/i, '').trim();

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const isLoopbackHttpUrl = (value: string): boolean =>
  isHttpUrl(value) && new URL(value).protocol === 'http:' && LOOPBACK_HOSTS.has(new URL(value).hostname);

/** The endpoint from the discovery file, mirroring the CLI's `buildEndpoint` fallback. */
export const discoveryEndpoint = (info: DiscoveryInfo): string | null =>
  info.endpoint ?? (info.port ? `http://127.0.0.1:${info.port}/mcp` : null);

export type ResolveOptions = {
  env: BridgeEnv;
  homeDir: string;
  pidAlive?: (pid: number) => boolean;
};

/**
 * Resolves where to send MCP traffic. App state is reported before pairing:
 * pairing cannot succeed until the app runs with its MCP server on.
 */
export const resolveTarget = ({ env, homeDir, pidAlive = isPidAlive }: ResolveOptions): TargetResolution => {
  const urlOverride = firstEnv(env, URL_ENV_NAMES);
  let endpoint: string;
  let appVersion: string | null = null;
  if (urlOverride) {
    if (!isHttpUrl(urlOverride.value)) {
      return { ok: false, failure: invalidConfig(`${urlOverride.name} must be an http:// or https:// URL.`) };
    }
    endpoint = urlOverride.value;
  } else {
    const info = readDiscovery(homeDir);
    if (!info || !pidAlive(info.pid)) return { ok: false, failure: appNotRunning() };
    const found = discoveryEndpoint(info);
    if (!info.mcpEnabled || !found) return { ok: false, failure: mcpDisabled() };
    if (!isLoopbackHttpUrl(found)) {
      return { ok: false, failure: invalidConfig('~/.jamsql/mcp-discovery.json names a non-local endpoint; refusing to send the token there.') };
    }
    endpoint = found;
    appVersion = info.version;
  }

  const tokenOverride = firstEnv(env, TOKEN_ENV_NAMES);
  const token = tokenOverride ? normalizeToken(tokenOverride.value) : readCredentialsToken(homeDir);
  if (!token) return { ok: false, failure: notPaired() };

  return { ok: true, target: { endpoint, token, source: urlOverride ? 'env' : 'discovery', appVersion } };
};
