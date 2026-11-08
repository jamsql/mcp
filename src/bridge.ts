/**
 * stdio side of the bridge: newline-delimited JSON-RPC on stdin, answers on
 * stdout, human messages on stderr. Every request gets an answer — when the
 * app cannot be reached the answer is a JSON-RPC error carrying the same
 * actionable message that goes to stderr.
 *
 * Messages that arrive while the client's `initialize` is in flight wait for
 * it, so they travel on the session it creates.
 */

import * as readline from 'node:readline';
import type { BridgeEnv } from './discovery';
import { errorResponse, isInitialize, isJsonRpcPayload, parseErrorResponse, type JsonRpcPayload } from './jsonrpc';
import { createLogger } from './logger';
import { BRIDGE_VERSION, DOCS_URL, type BridgeFailure } from './messages';
import { createAppSession } from './session';

export type BridgeOptions = {
  env: BridgeEnv;
  homeDir: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  pidAlive?: (pid: number) => boolean;
  retryDelaysMs?: readonly number[];
  /** How long stdin EOF waits for in-flight answers before the session is closed. */
  drainTimeoutMs?: number;
};

export type RunningBridge = {
  /** Resolves after stdin ended, in-flight answers drained and the session closed. */
  finished: Promise<void>;
  /** Closes the app session now (signal handling). */
  close: () => Promise<void>;
};

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

const invalidRequest = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC message.' } };

export const runBridge = (options: BridgeOptions): RunningBridge => {
  const log = createLogger(options.errorOutput, options.env.JAMSQL_MCP_DEBUG === '1');
  const session = createAppSession({
    env: options.env,
    homeDir: options.homeDir,
    log,
    pidAlive: options.pidAlive,
    retryDelaysMs: options.retryDelaysMs,
  });
  const inflight = new Set<Promise<void>>();
  let initializing: Promise<void> = Promise.resolve();
  let lastFailure = '';
  let connected = false;

  const write = (message: unknown): void => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };

  const reportFailure = (failure: BridgeFailure): void => {
    if (failure.message === lastFailure) return;
    lastFailure = failure.message;
    connected = false;
    log.info(failure.message);
  };

  const handle = async (payload: JsonRpcPayload): Promise<void> => {
    const result = await session.send(payload, write);
    if (!result.ok) {
      reportFailure(result.failure);
      for (const id of result.unansweredIds) write(errorResponse(id, result.failure));
      return;
    }
    lastFailure = '';
    if (!connected && isInitialize(payload)) {
      connected = true;
      log.info(`Connected to ${session.describeTarget()}.`);
    }
  };

  const track = (work: Promise<void>): void => {
    const settled = work.catch((error: unknown) => {
      log.info(`Unexpected bridge error: ${error instanceof Error ? error.message : String(error)}`);
    });
    inflight.add(settled);
    void settled.finally(() => inflight.delete(settled));
  };

  const onLine = (line: string): void => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.info('Ignored a stdin line that is not JSON.');
      write(parseErrorResponse());
      return;
    }
    if (!isJsonRpcPayload(parsed)) {
      write(invalidRequest);
      return;
    }
    const payload = parsed;
    if (isInitialize(payload)) {
      const run = handle(payload);
      initializing = run.catch(() => undefined);
      track(run);
      return;
    }
    const waitFor = initializing;
    track(waitFor.then(() => handle(payload)));
  };

  log.info(`${BRIDGE_VERSION} — bridging stdio to Jam SQL Studio's local MCP server. Docs: ${DOCS_URL}`);
  const lines = readline.createInterface({ input: options.input, crlfDelay: Infinity, terminal: false });
  lines.on('line', onLine);

  const finished = new Promise<void>((done) => {
    lines.once('close', () => {
      const drained = Promise.allSettled([...inflight]);
      const timeout = new Promise<void>((elapsed) => setTimeout(elapsed, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS).unref());
      void Promise.race([drained, timeout])
        .then(() => session.close())
        .then(() => done());
    });
  });

  return { finished, close: () => session.close() };
};
