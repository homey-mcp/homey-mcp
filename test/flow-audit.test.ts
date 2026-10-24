import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFlows, cardDefRequests, describeCard, mapLimit, MALFORMED_DROPTOKEN, MISSING_ACTION_GROUP } from "../src/lib/flow-audit.js";

const DEV = "11111111-1111-4111-8111-111111111111";
const DEV_OFF = "22222222-2222-4222-8222-222222222222";
const DEV_GONE = "33333333-3333-4333-8333-333333333333";
const VAR = "44444444-4444-4444-8444-444444444444";
const VAR_GONE = "55555555-5555-4555-8555-555555555555";
const SCRIPT = "66666666-6666-4666-8666-666666666666";
const SCRIPT_GONE = "77777777-7777-4777-8777-777777777777";
const FLOW_GONE = "88888888-8888-4888-8888-888888888888";

const devices = { [DEV]: { name: "Lamp", available: true }, [DEV_OFF]: { name: "Plug", available: false } };
const variables = { [VAR]: { name: "mode" } };
const scripts = { [SCRIPT]: { id: SCRIPT, name: "Controller" } };

const COUNTDOWN_SET = "homey:app:nl.bevlogenheid.countdown:set_countdown_timer";
const LOGIC_SET = "homey:manager:logic:variable_set_string";
const RUN = "homey:app:com.athom.homeyscript:run";
const PROG = "homey:manager:flow:programmatic_trigger";
const TRIG = "homey:app:com.x:something_happened";
const DEVTRIG = `homey:device:${DEV}:alarm_motion_true`;
const COND = `homey:device:${DEV}:onoff`;
const COND2 = "homey:manager:logic:equal";

const cardDefs = new Map<string, any>([
  [`then:${COUNTDOWN_SET}`, { args: [{ name: "variable", type: "autocomplete" }, { name: "value", type: "text" }] }],
  [`then:${LOGIC_SET}`, { args: [{ name: "variable", type: "autocomplete" }, { name: "value", type: "text" }] }],
  [`then:${RUN}`, { args: [{ name: "script", type: "autocomplete" }] }],
  [`then:${PROG}`, { args: [{ name: "flow", type: "autocomplete" }] }],
  [`when:${TRIG}`, { args: [{ name: "device", type: "device" }, { name: "note", type: "text", required: false }, { name: "flag", type: "checkbox" }, { name: "before", type: "number", value: 0 }] }],
  [`when:${DEVTRIG}`, { args: [] }],
  [`and:${COND}`, { args: [] }],
  [`and:${COND2}`, { args: [{ name: "a", type: "text" }] }],
]);

const flows = {
  f1: {
    id: "f1", name: "Bath — Light", enabled: true, broken: false,
    trigger: { id: DEVTRIG, args: { stale: 1 } },
    conditions: [{ id: COND, group: "group1" }, { id: COND2, args: { a: "x" }, droptoken: `homey:device:${DEV}:measure_temperature` }],
    actions: [
      { id: COUNTDOWN_SET, group: "then", args: { variable: { name: "Bath" }, value: 600 } },
      { id: COUNTDOWN_SET, group: "then", args: { variable: { name: "Bath" }, value: "600" } },
      { id: LOGIC_SET, args: { variable: { id: VAR_GONE, name: "old" }, value: "x" } },
      { id: LOGIC_SET, group: "then", args: { variable: { id: VAR, name: "mode" }, value: "x" } },
      { id: RUN, group: "then", args: { script: { id: SCRIPT_GONE, name: "Deleted" } } },
      { id: RUN, group: "then", args: { script: { id: SCRIPT, name: "Controller" } } },
      { id: PROG, group: "then", args: { flow: { id: FLOW_GONE, name: "Gone" } } },
      { id: PROG, group: "then", args: { flow: { id: "f2", name: "Other" } } },
      { id: `homey:device:${DEV_OFF}:on`, group: "then" },
      { id: `homey:device:${DEV_GONE}:on`, group: "then" },
    ],
  },
  f2: {
    id: "f2", name: "App — Trigger", enabled: false, broken: true,
    trigger: { id: TRIG, args: {} },
    conditions: [{ id: COND2, args: { a: `homey:manager:logic|${VAR_GONE}` } }],
    actions: [],
  },
};

const advancedFlows = {
  a1: {
    id: "a1", name: "Adv", enabled: true, broken: false,
    cards: {
      c1: { type: "trigger", id: DEVTRIG },
      c2: { type: "action", id: COUNTDOWN_SET, args: { variable: { name: "Adv" }, value: 30 } },
      c3: { type: "note", value: "ignored" },
    },
  },
};

const result = auditFlows({ flows, advancedFlows, devices, variables, scripts, cardDefs });

test("counts simple and advanced flows", () => {
  assert.equal(result.total, 2);
  assert.equal(result.advancedTotal, 1);
  assert.deepEqual(result.broken.map((x: any) => x.id), ["f2"]);
  assert.deepEqual(result.disabled.map((x: any) => x.id), ["f2"]);
});

test("flags actions without group (simple flows only)", () => {
  assert.equal(result.actionsWithoutGroup.length, 1);
  assert.equal(result.actionsWithoutGroup[0].action, LOGIC_SET);
});

test("flags malformed token references", () => {
  assert.equal(result.malformedTokenReferences.length, 1);
  assert.equal(result.malformedTokenReferences[0].id, "f1");
});

test("flags numbers stored in text args, in simple and advanced flows", () => {
  assert.deepEqual(result.nonStringTextArgs.map((x: any) => [x.id, x.arg, x.value]), [["f1", "value", 600], ["a1", "value", 30]]);
});

test("flags missing required args, skipping optional, checkbox and defaulted args", () => {
  assert.deepEqual(result.missingRequiredArgs.map((x: any) => [x.id, x.arg]), [["f2", "device"]]);
});

test("flags mixed condition groups", () => {
  assert.deepEqual(result.mixedConditionGroups.map((x: any) => [x.id, x.grouped, x.ungrouped]), [["f1", 1, 1]]);
});

test("finds missing variables in object args and in token strings", () => {
  const ids = result.missingVariables.map((x: any) => [x.id, x.variableId]);
  assert.deepEqual(ids, [["f1", VAR_GONE], ["f2", VAR_GONE]]);
});

test("finds missing scripts and missing target flows in object args", () => {
  assert.deepEqual(result.missingScripts.map((x: any) => x.scriptId), [SCRIPT_GONE]);
  assert.deepEqual(result.missingFlows.map((x: any) => x.flowId), [FLOW_GONE]);
});

test("finds missing and unavailable devices", () => {
  assert.deepEqual(result.missingDevices.map((x: any) => x.deviceId), [DEV_GONE]);
  assert.deepEqual(result.unavailableDevices.map((x: any) => x.device), ["Plug"]);
});

test("flags stale trigger args", () => {
  assert.deepEqual(result.staleTriggerArgs.map((x: any) => [x.id, x.staleArgs]), [["f1", ["stale"]]]);
});

test("summary counts every finding list", () => {
  assert.equal(result.summary.nonStringTextArgs, 2);
  assert.equal(result.summary.missingScripts, 1);
  assert.equal("total" in result.summary, false);
});

test("skips script checks when the script list is unavailable", () => {
  const r = auditFlows({ flows, advancedFlows: {}, devices, variables, scripts: null, cardDefs });
  assert.equal(r.missingScripts.length, 0);
  assert.equal(r.scriptsChecked, false);
});

test("cardDefRequests returns one request per unique kind and card id", () => {
  const reqs = cardDefRequests(flows, advancedFlows);
  const keys = reqs.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes(`then:${COUNTDOWN_SET}`));
  assert.ok(keys.includes(`when:${DEVTRIG}`));
  const run = reqs.find((r) => r.key === `then:${RUN}`)!;
  assert.equal(run.uri, "homey:app:com.athom.homeyscript");
});

test("mapLimit preserves order and never exceeds the limit", async () => {
  let active = 0; let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5 * (8 - n)));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3);
});

test("describeCard keeps every warning on a card", () => {
  const out = describeCard({ id: "x", droptoken: "homey:device:abc:temp" }, true, (s) => s);
  assert.deepEqual(out?.warnings, [MALFORMED_DROPTOKEN, MISSING_ACTION_GROUP]);
  const clean = describeCard({ id: "x", group: "then", droptoken: "a|b" }, true, (s) => s);
  assert.equal(clean?.warnings, undefined);
});
