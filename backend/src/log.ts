// Structured logging with a request id, for the JSON-lines log pipeline (docs/09 §4 ops).
//
// Two formats, one code path: `LOG_FORMAT=json` (default in production) writes one JSON object
// per line so Loki/CloudWatch/Datadog can index it; `LOG_FORMAT=pretty` writes a single readable
// line for local runs and for the vitest output. `LOG_LEVEL` filters.
//
// Every line carries the request id, and the same id goes back to the client as `x-request-id`,
// which is what makes a user report ("error at 14:02, pack purchase") searchable in the logs and
// quotable in a support ticket. The id is generated here rather than trusted from the proxy by
// default; `TRUST_REQUEST_ID=1` adopts `x-request-id` from the edge (Cloudflare/Vercel/nginx) when
// that header is already set, so one id spans CDN → API → RPC crank logs.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN: Level = (process.env.LOG_LEVEL as Level) || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const JSON_OUT = process.env.LOG_FORMAT ? process.env.LOG_FORMAT === 'json' : process.env.NODE_ENV === 'production';

export interface LogFields { [k: string]: unknown }
export interface LogContext { requestId?: string; wallet?: string; route?: string; method?: string }

const ctx = new AsyncLocalStorage<LogContext>();

/** The id / wallet the current request is associated with (empty outside a request). */
export function logContext(): LogContext { return ctx.getStore() ?? {}; }
export function runWithContext<T>(fields: LogContext, fn: () => T): T { return ctx.run({ ...logContext(), ...fields }, fn); }

/**
 * A logger that throws is worse than no logger: it turns a diagnostic into an outage. So values are
 * stringified defensively — cycles, BigInt, getters that throw, and 10 MB arrays all become a short
 * summary instead of a stack trace from inside `res.json`.
 */
function safeValue(v: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (v === null || v === undefined) return v ?? null;
  const t = typeof v;
  if (t === 'bigint') return String(v);
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'string') return (v as string).length > 2_000 ? `${(v as string).slice(0, 2_000)}…+${(v as string).length - 2_000} chars` : v;
  if (t === 'function') return `[fn ${(v as { name?: string }).name ?? 'anonymous'}]`;
  if (t === 'symbol' || t === 'undefined') return String(v);
  if (t !== 'object') return String(v);
  const o = v as object;
  if (seen.has(o)) return '[circular]';
  if (depth > 3) return Array.isArray(v) ? `[array ${v.length}]` : '[depth]';
  seen.add(o);
  if (v instanceof Error) return { message: v.message, ...(v as { code?: string }).code ? { code: (v as { code?: string }).code } : {} };
  if (Array.isArray(v)) return v.slice(0, 24).map((x) => safeValue(x, depth + 1, seen));
  if (v instanceof Map) return Object.fromEntries([...v.entries()].slice(0, 24).map(([k, x]) => [String(k), safeValue(x, depth + 1, seen)]));
  if (v instanceof Set) return [...v].slice(0, 24).map((x) => safeValue(x, depth + 1, seen));
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (n++ > 24) { out['…'] = 'truncated'; break; }
    try { out[k] = safeValue(x, depth + 1, seen); } catch { out[k] = '[throw]'; }
  }
  return out;
}

export function safeJson(fields: LogFields): string {
  try { return JSON.stringify(safeValue(fields)); } catch { return '{"fields":"unserialisable"}'; }
}

function line(level: Level, msg: string, fields?: LogFields): string | undefined {
  if (RANK[level] < RANK[MIN]) return undefined;
  const at = new Date().toISOString();
  const merged = { at, level, msg, ...logContext(), ...(fields ?? {}), ...(fields?.pid ? {} : { pid: process.pid }) };
  if (JSON_OUT) return safeJson(merged);
  const kv = Object.entries(merged)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : String(safeValue(v))}`)
    .join(' ');
  return `${at} ${level.toUpperCase().padEnd(5)} ${msg}${kv ? `  ${kv}` : ''}`;
}

function emit(level: Level, msg: string, fields?: LogFields, stream: NodeJS.WritableStream = process.stdout) {
  const s = line(level, msg, fields);
  if (s === undefined) return;
  stream.write(s + '\n');
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields, process.stderr),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields, process.stderr),
  /** One ALERT line that both the log pipeline and a human on the box can grep. Keep the exact word. */
  alert: (msg: string, fields?: LogFields) => emit('error', `ALERT ${msg}`, { alert: true, ...fields }, process.stderr),
};

/** Serialise an Error for a log line (message + stack tail + code, never the whole stack in JSON). */
export function errFields(e: unknown): LogFields {
  const err = e as (Error & { code?: string; cause?: Error }) | undefined;
  return {
    err: err?.message ?? String(e),
    ...(err?.name && err.name !== 'Error' ? { errName: err.name } : {}),
    ...(err?.code ? { errCode: err.code } : {}),
    ...(process.env.LOG_LEVEL === 'debug' && err?.stack ? { stack: err.stack.split('\n').slice(0, 6).join(' | ') } : {}),
  };
}

const ID_OK = /^[A-Za-z0-9_.-]{1,64}$/;
export function newRequestId(): string { return randomUUID().replace(/-/g, '').slice(0, 16); }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { requestId?: string; startedAt?: number }
  }
}

/**
 * Request id + access log + async context. Mounted before the router so that even a rate-limited
 * or 500-ing request produces exactly one access line with a duration.
 */
export function requestLogger(opts: { logLines?: boolean } = {}): (req: Request, res: Response, next: NextFunction) => void {
  const trust = process.env.TRUST_REQUEST_ID === '1';
  const lines = opts.logLines !== false;
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = (trust && incoming && ID_OK.test(incoming) ? incoming : newRequestId())!;
    req.requestId = requestId;
    req.startedAt = Number(process.hrtime.bigint());
    res.setHeader('x-request-id', requestId);
    ctx.run({ requestId }, () => {
      // The header and the async context are set even when the per-request line is suppressed: the id
      // is what the 500 handler quotes, and a test that silences the log must not silence the id.
      if (!lines) { next(); return; }
      res.once('finish', () => {
        const started = req.startedAt ?? 0;
        const us = started ? Number(process.hrtime.bigint()) - started : 0;
        const status = res.statusCode;
        const level: Level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
        emit(level, 'http', {
          method: req.method, route: routePattern(req), path: rawPath(req), status, durMs: Math.round(us / 1e3 / 10) / 100,
          ...(req.ip ? { ip: req.ip } : {}),
          ...(res.getHeader('content-length') ? { bytes: Number(res.getHeader('content-length')) } : {}),
        });
      });
      next();
    });
  };
}

/**
 * The templated route (`/v1/packs/quote`), never the raw URL: a path segment is a wallet or an asset
 * id, which would blow up metric cardinality and put user data into a log shipper's index. A request
 * that matched no route collapses to `<base>!unmatched` — one bucket, and a scanner hitting random
 * paths still shows up as a spike on it.
 */
export function routePattern(req: Request): string {
  const routePath = (req.route as { path?: string } | undefined)?.path;
  const base = req.baseUrl && req.baseUrl !== '/' ? req.baseUrl : '';
  if (typeof routePath === 'string') return base + (routePath === '/' ? '' : routePath) || '/';
  return `${base}!unmatched`;
}

/** The request path for a human-readable access-log line (truncated; never used as a metric label). */
export function rawPath(req: Request): string {
  return (req.originalUrl ?? req.path ?? '/').split('?')[0].slice(0, 120);
}

/** Replace `console.log/error` inside a process so legacy call sites land in the same pipeline. */
export function hijackConsole(): void {
  console.log = (...a: unknown[]) => log.info(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.info = console.log;
  console.warn = (...a: unknown[]) => log.warn(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.error = (...a: unknown[]) => log.error(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
}
