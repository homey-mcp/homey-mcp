import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../src/lib/ttl-cache.js";

test("TtlCache reuses a value within the TTL and refetches after it", async () => {
  let now = 0; let calls = 0;
  const cache = new TtlCache(1000, () => now);
  const load = async () => ++calls;
  assert.equal(await cache.get("k", load), 1);
  now = 999;
  assert.equal(await cache.get("k", load), 1);
  now = 1000;
  assert.equal(await cache.get("k", load), 2);
});

test("TtlCache shares one in-flight load between concurrent callers", async () => {
  let calls = 0;
  const cache = new TtlCache(1000, () => 0);
  const load = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return "v"; };
  const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
  assert.equal(a, "v"); assert.equal(b, "v"); assert.equal(calls, 1);
});

test("TtlCache does not keep a failed load", async () => {
  let calls = 0;
  const cache = new TtlCache(1000, () => 0);
  await assert.rejects(cache.get("k", async () => { calls++; throw new Error("x"); }));
  assert.equal(await cache.get("k", async () => { calls++; return 7; }), 7);
  assert.equal(calls, 2);
});

test("TtlCache.clear drops everything", async () => {
  let calls = 0;
  const cache = new TtlCache(1000, () => 0);
  await cache.get("k", async () => ++calls);
  cache.clear();
  assert.equal(await cache.get("k", async () => ++calls), 2);
});
