import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiHolder, isAuthError, isNotFound, unlessAuth, isRetrySafe, isLanAddress, isGroupOrWorldAccessible } from "../src/lib/auth.js";

test("isAuthError matches statusCode 401 and the exact session-not-found message only", () => {
  assert.equal(isAuthError({ statusCode: 401, message: "whatever" }), true);
  assert.equal(isAuthError(new Error("Session not found")), true);
  assert.equal(isAuthError({ message: "  session not found " }), true);
  assert.equal(isAuthError({ description: "Session Not Found" }), true);
  // free-text matches are not auth errors: a script or cloud driver that says
  // "Unauthorized" must not reset the Homey session or re-run the handler
  assert.equal(isAuthError(new Error("Unauthorized")), false);
  assert.equal(isAuthError(new Error("Cloud driver: unauthorized (token expired)")), false);
  assert.equal(isAuthError(new Error("Session not found for device")), false);
  assert.equal(isAuthError({ statusCode: 403 }), false);
  assert.equal(isAuthError({ code: 401 }), false);
  assert.equal(isAuthError(null), false);
  assert.equal(isAuthError(undefined), false);
});

test("isNotFound matches statusCode 404 only", () => {
  assert.equal(isNotFound({ statusCode: 404 }), true);
  assert.equal(isNotFound({ statusCode: 500, message: "not found" }), false);
  assert.equal(isNotFound(null), false);
});

test("unlessAuth returns the fallback for other errors and rethrows auth errors", () => {
  assert.equal(unlessAuth(null)(new Error("boom")), null);
  assert.deepEqual(unlessAuth([])({ statusCode: 500 }), []);
  assert.throws(() => unlessAuth(null)({ statusCode: 401 }), (e: any) => e.statusCode === 401);
});

test("isRetrySafe allows read-only and idempotent tools only", () => {
  assert.equal(isRetrySafe({ readOnlyHint: true }), true);
  assert.equal(isRetrySafe({ readOnlyHint: false, idempotentHint: true }), true);
  assert.equal(isRetrySafe({ readOnlyHint: false, idempotentHint: false }), false);
  assert.equal(isRetrySafe({ readOnlyHint: false, destructiveHint: true }), false);
  assert.equal(isRetrySafe(undefined), false);
});

test("isLanAddress rejects the Athom cloud relay", () => {
  assert.equal(isLanAddress("https://192-168-1-5.homey.homeylocal.com"), true);
  assert.equal(isLanAddress("http://192.168.1.20"), true);
  assert.equal(isLanAddress("https://abc123.connect.athom.com"), false);
  assert.equal(isLanAddress("not a url"), false);
});

test("isGroupOrWorldAccessible checks the low six permission bits", () => {
  assert.equal(isGroupOrWorldAccessible(0o100600), false);
  assert.equal(isGroupOrWorldAccessible(0o100644), true);
  assert.equal(isGroupOrWorldAccessible(0o100640), true);
  assert.equal(isGroupOrWorldAccessible(0o40700), false);
  assert.equal(isGroupOrWorldAccessible(0o40755), true);
});

function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("ApiHolder coalesces concurrent callers onto one authentication", async () => {
  let calls = 0;
  const d = deferred<object>();
  const holder = new ApiHolder(() => { calls++; return d.promise; }, () => {});
  const p1 = holder.get(); const p2 = holder.get();
  const api = {}; d.resolve(api);
  assert.equal(await p1, api); assert.equal(await p2, api);
  assert.equal(calls, 1);
  assert.equal(await holder.get(), api);
  assert.equal(calls, 1);
});

test("ApiHolder.reset(failed) resets once when concurrent callers fail on the same instance", async () => {
  const instances = [{ n: 1 }, { n: 2 }, { n: 3 }];
  let calls = 0; let discards = 0;
  const holder = new ApiHolder(async () => instances[calls++], () => { discards++; });
  const stale = await holder.get();
  // two pipelined calls both got a 401 on the stale instance
  assert.equal(holder.reset(stale), true);
  const fresh = holder.get();
  assert.equal(holder.reset(stale), false, "second reset must not clear the new in-flight auth");
  assert.equal(await fresh, instances[1]);
  assert.equal(holder.reset(stale), false, "late reset must not drop the fresh instance");
  assert.equal(await holder.get(), instances[1]);
  assert.equal(calls, 2);
  assert.equal(discards, 1, "the cache saved by the fresh auth must survive");
});

test("ApiHolder: a stale in-flight auth cannot overwrite a newer instance after an unconditional reset", async () => {
  const d1 = deferred<object>(); const d2 = deferred<object>();
  const queue = [d1, d2]; let calls = 0;
  const holder = new ApiHolder(() => queue[calls++].promise, () => {});
  const p1 = holder.get();
  holder.reset(); // unconditional
  const p2 = holder.get();
  const a2 = { n: 2 }; d2.resolve(a2); await p2;
  const a1 = { n: 1 }; d1.resolve(a1); await p1;
  assert.equal(await holder.get(), a2);
  assert.equal(calls, 2);
});

test("ApiHolder: a failed authentication is not cached", async () => {
  let calls = 0;
  const holder = new ApiHolder(async () => { calls++; if (calls === 1) throw new Error("offline"); return { ok: true }; }, () => {});
  await assert.rejects(holder.get(), /offline/);
  assert.deepEqual(await holder.get(), { ok: true });
  assert.equal(calls, 2);
});
