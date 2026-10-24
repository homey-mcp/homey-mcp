import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize, cleanString } from "../src/lib/sanitize.js";

test("cleanString strips control, bidi and zero-width characters but keeps newlines and tabs", () => {
  assert.equal(cleanString("a\u0000b\u001bc\u007fd\u0085e", 100), "abcde");
  assert.equal(cleanString("x\u202Ey\u2066z\u200B\uFEFF", 100), "xyz");
  assert.equal(cleanString("line1\nline2\tcol\r", 100), "line1\nline2\tcol");
  assert.equal(cleanString("Kök — 21 °C", 100), "Kök — 21 °C");
});

test("cleanString caps the length and says how much was cut", () => {
  const out = cleanString("a".repeat(50), 10);
  assert.ok(out.startsWith("a".repeat(10)));
  assert.match(out, /truncated 40 chars/);
});

test("sanitize walks objects and arrays, cleaning keys and string values", () => {
  const input = { "na\u0000me": "De\u202Evice", n: 5, b: true, nil: null, list: ["o\u0007k", { deep: "x\u0000" }] };
  assert.deepEqual(sanitize(input, 100), { name: "Device", n: 5, b: true, nil: null, list: ["ok", { deep: "x" }] });
});

test("sanitize leaves non-plain values to JSON.stringify", () => {
  const d = new Date(0);
  assert.equal(sanitize(d, 100), d);
  assert.equal(sanitize(undefined, 100), undefined);
});
