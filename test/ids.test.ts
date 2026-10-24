import { test } from "node:test";
import assert from "node:assert/strict";
import { uuid, appId, scriptId, insightLogId, isoDate, scriptPath } from "../src/lib/ids.js";

const ok = (schema: any, v: unknown) => schema.safeParse(v).success;

test("uuid ids accept a UUID and reject path traversal", () => {
  assert.equal(ok(uuid(), "5ca4bf89-67ab-4978-a355-da9e11c8cc05"), true);
  assert.equal(ok(uuid(), "5CA4BF89-67AB-1978-0355-DA9E11C8CC05"), true, "no RFC version/variant check");
  assert.equal(ok(uuid(), "../../system/reboot?x="), false);
  assert.equal(ok(uuid(), "5ca4bf89-67ab-4978-a355-da9e11c8cc05/../x"), false);
  assert.equal(ok(uuid(), ""), false);
});

test("app ids accept reverse-DNS ids and reject traversal", () => {
  assert.equal(ok(appId(), "com.athom.homeyscript"), true);
  assert.equal(ok(appId(), "nl.philips.hue"), true);
  assert.equal(ok(appId(), "ady.linknlink"), true);
  assert.equal(ok(appId(), "../../system/reboot?x="), false);
  assert.equal(ok(appId(), "com..evil"), false);
  assert.equal(ok(appId(), "com.x/restart"), false);
  assert.equal(ok(appId(), ".hidden"), false);
});

test("script ids accept slugs and UUIDs, reject dots and slashes", () => {
  assert.equal(ok(scriptId(), "487a9f18-968f-41fa-a947-cefb44d5da2e"), true);
  assert.equal(ok(scriptId(), "my_script-1"), true);
  assert.equal(ok(scriptId(), ".."), false);
  assert.equal(ok(scriptId(), "a/b"), false);
  assert.equal(ok(scriptId(), "a b"), false);
});

test("insight log ids accept homey URIs and reject traversal", () => {
  assert.equal(ok(insightLogId(), "homey:device:5ca4bf89-67ab-4978-a355-da9e11c8cc05:measure_temperature"), true);
  assert.equal(ok(insightLogId(), "homey:app:com.example.energy:meter_daily_cost"), true);
  assert.equal(ok(insightLogId(), "homey:manager:logic:x.y"), true);
  assert.equal(ok(insightLogId(), "homey:app:../../x"), false);
  assert.equal(ok(insightLogId(), "homey:device:x/entry?"), false);
  assert.equal(ok(insightLogId(), "device:x"), false);
});

test("isoDate requires YYYY-MM-DD", () => {
  assert.equal(ok(isoDate(), "2026-10-25"), true);
  assert.equal(ok(isoDate(), "2026-10-25/../x"), false);
  assert.equal(ok(isoDate(), "25/10/2026"), false);
});

test("scriptPath encodes the id segment", () => {
  assert.equal(scriptPath("abc"), "/api/app/com.athom.homeyscript/script/abc");
  assert.equal(scriptPath("a b", "run"), "/api/app/com.athom.homeyscript/script/a%20b/run");
  assert.equal(scriptPath(), "/api/app/com.athom.homeyscript/script");
});
