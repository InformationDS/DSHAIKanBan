/**
 * Deterministic key and fingerprint helpers.
 *
 * Storage keys are derived, never hand-written, because the core must be able
 * to move between `storageDomain` layouts without changing record identity.
 * `encodeKey` maps an arbitrary opaque identifier (a conversation, task or
 * project id) onto `[a-zA-Z0-9_-]+`, which is the per-record layout's
 * path-safety requirement (`SAFE_KEY_RE` in `@deepseek-ai/dsh-storage-json`),
 * while staying injective so distinct identifiers can never collide.
 *
 * @module @aikanban/core/keys
 */

/** Escape one opaque identifier into `[a-zA-Z0-9_-]+`, injectively. */
export function encodeKey(raw: string): string {
  let out = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    const alphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    // Note: '_' is deliberately escaped, which makes '_' a separator that can
    // never occur inside an encoded part. Composite keys stay unambiguous.
    out += alphanumeric ? char : `-${code.toString(16)}-`;
  }
  return out;
}

/**
 * Canonical JSON with recursively sorted object keys.
 * Used for change detection, so it must be stable across processes and
 * independent of insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** A deterministic 64-hex-character digest of a canonical value (FNV-1a pair). */
export function fingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** Strip insignificant whitespace so a formatting-only edit is recognisable. */
export function collapseWhitespace(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\s+/gu, ' ').trim();
  if (Array.isArray(value)) return value.map(collapseWhitespace);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = collapseWhitespace(item);
    return out;
  }
  return value;
}
