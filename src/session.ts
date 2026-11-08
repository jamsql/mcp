/**
 * The bridge's side of one MCP session with the app: which endpoint and
 * token to use, the `Mcp-Session-Id` / `Mcp-Protocol-Version` headers, and
 * recovery when the app goes away underneath an open client.
 *
 * Recovery rules:
 *  - A request that never reached the app (connection refused) is retried
 *    after re-reading discovery — the app may be restarting, maybe on a new
 *    port. Its old session died with it, so the client's `initialize` is
 *    replayed first.
 *  - An answer saying the session is unknown (the app's "MCP session
 *    expired" result, or a spec 404) replays `initialize` and retries once.
 *  - A 401 re-reads the token once (the user may have re-paired).
 *  - A request that reached the app is never retried: it may have run.
 */

import { exchange, type ExchangeResult } from './httpTransport';
import { resolveTarget, type BridgeEnv, type Target, type TargetResolution } from './discovery';
import {
  describePayload,
  isAppSessionExpiredAnswer,
  isInitialize,
  isJsonRpcMessage,
  isResponseTo,
  protocolVersionOf,
  requestIds,
  type JsonRpcId,
  type JsonRpcPayload,
} from './jsonrpc';
import { connectionLost, httpError, tokenRejected, unreachable, type BridgeFailure } from './messages';
import type { Logger } from './logger';
import { replayInitialize } from './replayInitialize';

export type SendResult = { ok: true } | { ok: false; failure: BridgeFailure; unansweredIds: JsonRpcId[] };

export type AppSession = {
  send: (payload: JsonRpcPayload, onMessage: (message: unknown) => void) => Promise<SendResult>;
  /** Ends the session on the app (best effort, bounded). */
  close: () => Promise<void>;
  /** "Jam SQL Studio 1.5.5 at http://127.0.0.1:14507/mcp" for the log — never the token. */
  describeTarget: () => string;
};

export type AppSessionOptions = {
  env: BridgeEnv;
  homeDir: string;
  log: Logger;
  pidAlive?: (pid: number) => boolean;
  /** Waits between attempts while the app is unreachable; their count is the retry budget. */
  retryDelaysMs?: readonly number[];
};

type Failed = { ok: false; failure: BridgeFailure; retryable: boolean };
type Attempt = { ok: true } | Failed;

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1000] as const;
const CLOSE_TIMEOUT_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export const createAppSession = (options: AppSessionOptions): AppSession => {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const { log } = options;
  let target: Target | null = null;
  let everResolved = false;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let initParams: unknown;
  let generation = 0;
  let sessionStale = false;
  let reconnecting: Promise<Attempt> | null = null;
  let reconnectCount = 0;

  const resolve = (): TargetResolution => {
    if (target) return { ok: true, target };
    const resolution = resolveTarget({ env: options.env, homeDir: options.homeDir, pidAlive: options.pidAlive });
    if (resolution.ok) {
      target = resolution.target;
      everResolved = true;
      log.addSecret(target.token);
    }
    return resolution;
  };

  const failureOf = (result: ExchangeResult, endpoint: string): Failed => {
    if (result.kind === 'network-error') {
      if (result.connected) return { ok: false, failure: connectionLost(), retryable: false };
      // Refused: discovery may explain it (app closed, MCP switched off) better than the socket error.
      target = null;
      const again = resolve();
      return { ok: false, failure: again.ok ? unreachable(endpoint, result.code) : again.failure, retryable: true };
    }
    if (result.kind === 'http-error' && result.status === 401) return { ok: false, failure: tokenRejected(), retryable: false };
    const detail = result.kind === 'http-error' ? result.detail : 'initialize returned no result';
    return { ok: false, failure: httpError(result.status, detail), retryable: false };
  };

  /** Replays the client's initialize on a fresh session; concurrent callers share one attempt. */
  const reconnect = (): Promise<Attempt> => {
    if (reconnecting) return reconnecting;
    reconnecting = (async (): Promise<Attempt> => {
      sessionId = null;
      const resolution = resolve();
      if (!resolution.ok) return { ok: false, failure: resolution.failure, retryable: true };
      const replay = await replayInitialize(resolution.target, initParams, `jamsql-mcp-reconnect-${(reconnectCount += 1)}`);
      if (!replay.ok) return failureOf(replay.result, resolution.target.endpoint);
      sessionId = replay.sessionId;
      protocolVersion = replay.protocolVersion;
      generation += 1;
      sessionStale = false;
      log.info(`Reconnected to ${describeTarget()} (new MCP session).`);
      return { ok: true };
    })().finally(() => {
      reconnecting = null;
    });
    return reconnecting;
  };

  const send: AppSession['send'] = async (payload, onMessage) => {
    const init = isInitialize(payload);
    const ids = requestIds(payload);
    const fail = (failure: BridgeFailure, unansweredIds: JsonRpcId[] = ids): SendResult => ({ ok: false, failure, unansweredIds });
    if (init) {
      initParams = payload.params;
      sessionId = null;
      protocolVersion = null;
      sessionStale = false;
      generation += 1;
    }
    let attempts = 0;
    let replayed = false;
    let tokenReread = false;
    const retryLater = async (): Promise<boolean> => {
      if (attempts >= delays.length) return false;
      await sleep(delays[attempts]);
      attempts += 1;
      target = null;
      return true;
    };

    for (;;) {
      const resolution = resolve();
      if (!resolution.ok) {
        // Only an app that was reachable before is worth waiting for (it is likely restarting).
        if (everResolved && (await retryLater())) continue;
        return fail(resolution.failure);
      }
      if (!init && sessionStale && initParams !== undefined) {
        const reconnected = await reconnect();
        if (!reconnected.ok) {
          if (reconnected.retryable && (await retryLater())) continue;
          return fail(reconnected.failure);
        }
      }

      const { endpoint, token } = resolution.target;
      const usedGeneration = generation;
      // A newer session than the one this request used means another request already reconnected.
      const markStale = (): void => {
        if (!init && initParams !== undefined && generation === usedGeneration) sessionStale = true;
      };
      const answered = new Set<JsonRpcId>();
      const deliver = (message: unknown): void => {
        if (!isJsonRpcMessage(message)) return;
        if (isResponseTo(message, ids)) answered.add(message.id as JsonRpcId);
        if (init) protocolVersion = protocolVersionOf(message) ?? protocolVersion;
        onMessage(message);
      };
      log.debug(`→ ${describePayload(payload)}`);
      const result = await exchange({
        endpoint,
        token,
        sessionId: init ? undefined : (sessionId ?? undefined),
        protocolVersion: init ? undefined : (protocolVersion ?? undefined),
        method: 'POST',
        body: JSON.stringify(payload),
        onStreamMessage: deliver,
      });
      log.debug(`← ${result.kind}${'status' in result ? ` ${result.status}` : ` ${result.code}`}`);

      if (result.kind === 'network-error') {
        if (!result.connected) {
          markStale();
          if (await retryLater()) continue;
        }
        return fail(failureOf(result, endpoint).failure);
      }
      if (result.kind === 'http-error' && result.status === 401 && !tokenReread) {
        tokenReread = true;
        target = null;
        const again = resolve();
        if (!again.ok) return fail(again.failure);
        if (again.target.token !== token) continue;
        return fail(tokenRejected());
      }
      const sessionUnknown =
        (result.kind === 'http-error' && result.status === 404) ||
        (result.kind === 'json' && isAppSessionExpiredAnswer(result.messages));
      if (sessionUnknown && !init && !replayed && initParams !== undefined) {
        replayed = true;
        markStale();
        continue;
      }
      if (result.kind === 'http-error') return fail(failureOf(result, endpoint).failure);

      if (init && result.kind !== 'accepted') sessionId = result.sessionId;
      if (result.kind === 'json') result.messages.forEach(deliver);
      const unanswered = ids.filter((id) => !answered.has(id));
      return unanswered.length === 0 ? { ok: true } : fail(connectionLost(), unanswered);
    }
  };

  const close: AppSession['close'] = async () => {
    if (!target || !sessionId) return;
    const request = exchange({
      endpoint: target.endpoint,
      token: target.token,
      sessionId,
      protocolVersion: protocolVersion ?? undefined,
      method: 'DELETE',
      connectTimeoutMs: CLOSE_TIMEOUT_MS,
    });
    sessionId = null;
    await Promise.race([request, sleep(CLOSE_TIMEOUT_MS)]);
  };

  const describeTarget = (): string =>
    target ? `Jam SQL Studio${target.appVersion ? ` ${target.appVersion}` : ''} at ${target.endpoint}` : 'Jam SQL Studio';

  return { send, close, describeTarget };
};
