// Browser shim for `util` — only `inspect` (pretty-printing) is used.
export function inspect(value: unknown, _opts?: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  } catch {
    return String(value);
  }
}
(inspect as unknown as { custom: symbol }).custom = Symbol.for('nodejs.util.inspect.custom');
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export default { inspect, TextEncoder, TextDecoder };
