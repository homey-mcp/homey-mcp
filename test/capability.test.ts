import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCapabilityWrite, isSecurityCapability } from "../src/lib/capability.js";

const device = (cls: string, caps: Record<string, any>) => ({ class: cls, capabilitiesObj: caps });
const thermostat = device("thermostat", {
  onoff: { type: "boolean", setable: true },
  target_temperature: { type: "number", setable: true, min: 16, max: 30 },
  measure_temperature: { type: "number", setable: false },
  thermostat_mode: { type: "enum", setable: true, values: [{ id: "heat" }, { id: "cool" }, { id: "auto" }] },
  "target_temperature.floor": { type: "number", setable: true },
  label: { type: "string", setable: true },
});
const ok = (d: any, cap: string, v: unknown, allow = false) => validateCapabilityWrite(d, cap, v, { allowSecurityCaps: allow });

test("accepts a valid write", () => {
  assert.equal(ok(thermostat, "onoff", true), null);
  assert.equal(ok(thermostat, "target_temperature", 21.5), null);
  assert.equal(ok(thermostat, "thermostat_mode", "heat"), null);
  assert.equal(ok(thermostat, "label", "x"), null);
  assert.equal(ok(thermostat, "target_temperature", 16), null);
  assert.equal(ok(thermostat, "target_temperature", 30), null);
});

test("rejects unknown and read-only capabilities", () => {
  assert.match(ok(thermostat, "dim", 0.5)!, /no capability "dim".*onoff/);
  assert.match(ok(thermostat, "measure_temperature", 20)!, /not setable/);
});

test("rejects wrong types", () => {
  assert.match(ok(thermostat, "onoff", "true")!, /boolean/);
  assert.match(ok(thermostat, "target_temperature", "21")!, /number/);
  assert.match(ok(thermostat, "target_temperature", Number.NaN)!, /number/);
  assert.match(ok(thermostat, "label", 1)!, /string/);
});

test("enforces min and max", () => {
  assert.match(ok(thermostat, "target_temperature", 15.9)!, /below the minimum 16/);
  assert.match(ok(thermostat, "target_temperature", 31)!, /above the maximum 30/);
});

test("enforces enum values", () => {
  assert.match(ok(thermostat, "thermostat_mode", "dry")!, /one of: heat, cool, auto/);
  assert.match(ok(thermostat, "thermostat_mode", 1)!, /one of/);
});

test("refuses security capabilities unless allowed", () => {
  const lock = device("lock", { locked: { type: "boolean", setable: true } });
  const garage = device("garagedoor", { garagedoor_closed: { type: "boolean", setable: true } });
  const alarm = device("homealarm", { homealarm_state: { type: "enum", setable: true, values: [{ id: "armed" }, { id: "disarmed" }] } });
  const siren = device("other", { alarm_generic: { type: "boolean", setable: true }, onoff: { type: "boolean", setable: true } });
  assert.match(ok(lock, "locked", false)!, /HOMEY_MCP_ALLOW_SECURITY_CAPS=1/);
  assert.match(ok(garage, "garagedoor_closed", false)!, /HOMEY_MCP_ALLOW_SECURITY_CAPS/);
  assert.match(ok(alarm, "homealarm_state", "disarmed")!, /HOMEY_MCP_ALLOW_SECURITY_CAPS/);
  assert.match(ok(siren, "alarm_generic", false)!, /HOMEY_MCP_ALLOW_SECURITY_CAPS/);
  assert.equal(ok(siren, "onoff", true), null);
  assert.equal(ok(lock, "locked", false, true), null);
  assert.equal(ok(alarm, "homealarm_state", "disarmed", true), null);
});

test("any capability on a lock, garage door or home alarm device is a security capability", () => {
  const lock = device("lock", { onoff: { type: "boolean", setable: true } });
  assert.match(ok(lock, "onoff", true)!, /HOMEY_MCP_ALLOW_SECURITY_CAPS/);
});

test("isSecurityCapability handles sub-capabilities", () => {
  assert.equal(isSecurityCapability("locked.front", "other"), true);
  assert.equal(isSecurityCapability("alarm_contact", "sensor"), true);
  assert.equal(isSecurityCapability("onoff", "light"), false);
  assert.equal(isSecurityCapability("target_temperature.floor", "thermostat"), false);
});

test("sub-capabilities validate against their own definition", () => {
  assert.equal(ok(thermostat, "target_temperature.floor", 22), null);
});
