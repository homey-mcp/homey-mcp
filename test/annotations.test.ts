import { test } from "node:test";
import assert from "node:assert/strict";
import { writeAnnotations } from "../src/lib/annotations.js";
import { isRetrySafe } from "../src/lib/auth.js";

const table = writeAnnotations(false);

test("tools that run arbitrary code or actions are destructive and never auto-retried", () => {
  for (const name of ["run_script", "upsert_script", "trigger_flow", "reboot_homey"]) {
    assert.equal(table[name].destructiveHint, true, name);
    assert.equal(table[name].idempotentHint, false, name);
    assert.equal(isRetrySafe(table[name]), false, name);
  }
});

test("disable and delete paths are destructive", () => {
  for (const name of ["set_flow_enabled", "enable_app", "uninstall_app", "delete_script", "delete_alarm"]) {
    assert.equal(table[name].destructiveHint, true, name);
  }
});

test("additive writes are not auto-retried", () => {
  for (const name of ["create_notification", "set_alarm", "create_backup", "restart_app"]) {
    assert.equal(isRetrySafe(table[name]), false, name);
  }
});

test("set_device_capability is destructive once security capabilities are allowed", () => {
  assert.equal(writeAnnotations(false).set_device_capability.destructiveHint, false);
  assert.equal(writeAnnotations(true).set_device_capability.destructiveHint, true);
});

test("no write tool claims to be read-only", () => {
  for (const [name, a] of Object.entries(table)) assert.equal(a.readOnlyHint, false, name);
});
