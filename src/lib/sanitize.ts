// Tool output carries text written by anyone with access to the home: device
// and flow names, notification text, script source and script output. It is
// returned as data, cleaned of characters that hide or reorder text, and
// capped in length.

// C0/C1 controls except \t and \n, bidi overrides/isolates, zero-width chars, BOM.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export function cleanString(s: string, maxLength: number): string {
  const clean = s.replace(HIDDEN, "");
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}… [truncated ${clean.length - maxLength} chars]`;
}

export function sanitize(value: unknown, maxLength: number): unknown {
  if (typeof value === "string") return cleanString(value, maxLength);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, maxLength));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[cleanString(k, maxLength)] = sanitize(v, maxLength);
    return out;
  }
  return value;
}
