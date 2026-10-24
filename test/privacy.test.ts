import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSystemInfo, coarseLocation } from "../src/lib/privacy.js";

test("pickSystemInfo drops network identifiers, cloud id and hostname", () => {
  const info = {
    homeyVersion: "12.0.0", homeyModelName: "Homey Pro", uptime: 100, freemem: 1, totalmem: 2, timezone: "Europe/Stockholm",
    wifiConnected: true, wifiStrength: -50, ethernetConnected: false,
    wifiSsid: "home-net", wifiMac: "aa:bb", wifiAddress: "192.168.1.2", wifiDefaultGateway: "192.168.1.1", wifiDns: ["1.1.1.1"],
    wifiSubnetMask: "255.255.255.0", ethernetMac: "cc:dd", ethernetAddress: "10.0.0.2", ethernetDefaultGateway: "10.0.0.1",
    ethernetDns: [], ethernetSubnetMask: "x", cloudId: "abc", hostname: "homey-123", bootId: "b",
  };
  const out = pickSystemInfo(info);
  assert.equal(out.homeyVersion, "12.0.0");
  assert.equal(out.wifiConnected, true);
  assert.equal(out.wifiStrength, -50);
  for (const k of ["wifiSsid", "wifiMac", "wifiAddress", "wifiDefaultGateway", "wifiDns", "wifiSubnetMask", "ethernetMac", "ethernetAddress", "ethernetDefaultGateway", "ethernetDns", "ethernetSubnetMask", "cloudId", "hostname", "bootId"]) {
    assert.equal(k in out, false, k);
  }
});

test("pickSystemInfo drops unknown keys that a firmware update might add", () => {
  assert.deepEqual(pickSystemInfo({ newSecretField: "x", homeyVersion: "1" }), { homeyVersion: "1" });
});

test("coarseLocation rounds coordinates to 2 decimals and withholds the address", () => {
  const out = coarseLocation({ value: { latitude: 59.334591, longitude: 18.06324, accuracy: 10 } }, { value: "Street 1" }, false);
  assert.deepEqual(out.location, { latitude: 59.33, longitude: 18.06, accuracy: 10 });
  assert.match(String(out.address), /HOMEY_MCP_PRECISE_LOCATION=1/);
  assert.equal(out.precise, false);
});

test("coarseLocation returns exact data when precise is allowed", () => {
  const out = coarseLocation({ value: { latitude: 59.334591, longitude: 18.06324 } }, { value: "Street 1" }, true);
  assert.deepEqual(out.location, { latitude: 59.334591, longitude: 18.06324 });
  assert.deepEqual(out.address, "Street 1");
});

test("coarseLocation handles missing data", () => {
  assert.deepEqual(coarseLocation(null, null, false), { address: null, location: null, precise: false });
});
