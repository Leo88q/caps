// Graceful shutdown for every long-lived backend process (docs/09 §4.1). Without it a rolling
// deploy truncates in-flight packs: the crank has a tx in the air, an indexer is mid-batch, and
// systemd/docker's 10 s default SIGTERM→SIGKILL gap kills the process anyway — so the real cost of
// not doing this is a `pending_pack` that a player has to refund (docs/06 §3.1).
//
// The order is the contract:
//   1. mark unready  — /readyz starts returning 503 so the LB stops sending new requests
//   2. stop accepting — server.close() drains in-flight HTTP, no new connections
//   3. close sockets  — WS clients get 1001 and reconnect to the next replica
//   4. stop workers   — timers (crank sweep, listen heal, finality) are cleared, then the current
//                       iteration is awaited; the crank never aborts between submit and confirmation
//   5. flush          — rate-limit / metrics writes, then the DB handle
//   6. hard timeout   — anything still open after `forceMs` is SIGKILL material, so exit(1)
import { log } from './log.ts';
import { metrics } from './metrics.ts';

// One unlabeled counter: `increase(process_crashes_total[15m]) > 0` is the rule in
// ops/monitoring/alerts.yml, and a per-`kind` label would make every crash a *new* series whose first
// sample can never be an increase — the alert would fire on the second crash instead of the first.
// Seeded to 0 both here and in `createApp`, so the baseline exists for a worker process too.
const metricsAlert = () => { metrics.counter('process_crashes_total'); metrics.gauge('process_last_crash_at', Date.now()); };

export interface ShutdownStep { name: string; run: () => void | Promise<void> }
export interface ShutdownOptions {
  forceMs?: number;
  onExit?: (code: number) => void;
  /** Install the SIGTERM/SIGINT handlers. `false` for an embedder (tests, the API process) that drives `signal()` itself. */
  signals?: boolean;
  /** Install the crash-first handlers. Off in tests, where an unrelated rejection must not exit the runner. */
  crashHandlers?: boolean;
}

export interface ShutdownHandle {
  signal(signal: NodeJS.Signals): Promise<void>;
  steps: ShutdownStep[];
}

export function installShutdown(steps: ShutdownStep[], opts: ShutdownOptions = {}): ShutdownHandle {
  const forceMs = opts.forceMs ?? Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 25_000);
  const exit = opts.onExit ?? ((code: number) => process.exit(code));
  let running: Promise<void> | undefined;
  const handle: ShutdownHandle = { steps, signal };
  async function runStep(s: ShutdownStep): Promise<void> {
    const t0 = Date.now();
    try { await s.run(); log.info(`shutdown: ${s.name} done`, { ms: Date.now() - t0 }); }
    catch (e) { log.warn(`shutdown: ${s.name} failed after ${Date.now() - t0} ms`, { err: (e as Error)?.message ?? String(e) }); }
  }
  async function signal(_signal?: NodeJS.Signals): Promise<void> {
    if (running) return running;
    running = (async () => {
      let timedOut = false;
      const killer = forceMs > 0 ? setTimeout(() => { timedOut = true; log.error('ALERT shutdown timed out — exiting non-zero', { forceMs }); exit(1); }, forceMs) : undefined;
      killer?.unref?.();
      for (const s of steps) {
        if (timedOut) break;
        await runStep(s);
      }
      if (killer) clearTimeout(killer);
      if (!timedOut) exit(0);
    })();
    return running;
  }
  if (opts.signals !== false) {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => { log.info(`shutdown: ${sig} received`); void signal(sig); });
    }
  }
  if (opts.crashHandlers === false) return handle;
  // Crash-first on an uncaught exception: the alternative is serving requests from a process whose
  // invariants already broke. The supervisor (systemd Restart=on-failure / docker restart policy /
  // fly's autostop) brings a clean one back, and the step list above is what makes that cheap.
  process.on('unhandledRejection', (reason) => { log.error('unhandledRejection', { reason: String(reason) }); metricsAlert(); });
  process.on('uncaughtException', (e) => {
    log.error('ALERT uncaughtException — shutting down', { err: (e as Error)?.message ?? String(e) });
    metricsAlert();
    void signal('SIGTERM');
    const hard = setTimeout(() => exit(1), Math.max(250, Math.floor(forceMs / 4)));
    hard.unref?.();
  });
  return handle;
}
