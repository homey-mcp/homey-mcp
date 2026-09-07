#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getHomeyApi, resetHomeyApi, isAuthError } from "./homey.js";

const server = new McpServer({
  name: "homey-mcp",
  version: "2.1.0",
});

// Self-heal wrapper: every tool handler acquires `api` via getHomeyApi() at its
// top. If a cached local session expired, the first Homey call throws 401. We
// reset the auth (memo + on-disk cache) and re-run the handler once against a
// freshly authenticated API. A second failure is real and propagates.
function withAuthRetry<A extends any[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await handler(...args);
    } catch (e) {
      if (!isAuthError(e)) throw e;
      resetHomeyApi();
      return await handler(...args);
    }
  };
}

// Wrap registerTool so every handler gets auth self-heal transparently.
const _registerTool = server.registerTool.bind(server);
(server as any).registerTool = (name: string, config: any, handler: any) =>
  _registerTool(name, config, withAuthRetry(handler) as any);

// ── Helpers ──────────────────────────────────────────────────────────

function fmtDevice(d: any, zones?: Record<string, any>) {
  const caps = d.capabilitiesObj ?? {};
  const values: Record<string, any> = {};
  for (const [k, v] of Object.entries(caps) as any[]) {
    if (v.value !== null && v.value !== undefined) {
      values[k] = v.units ? `${v.value} ${v.units}` : v.value;
    }
  }
  return {
    id: d.id,
    name: d.name,
    class: d.class,
    zone: zones?.[d.zone]?.name ?? d.zone,
    available: d.available,
    capabilities: d.capabilities,
    values,
  };
}

function json(data: any): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text: msg }], isError: true };
}

const READ = { readOnlyHint: true, destructiveHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

// ── Devices ──────────────────────────────────────────────────────────

server.registerTool("list_devices", {
  title: "List Devices",
  description: "List all Homey devices with current capability values. Returns device ID, name, class, zone, availability, capabilities, and live sensor/state values. Use 'zone' to filter by room name (partial match) or 'class' to filter by device type (light, sensor, thermostat, speaker, lock, socket, etc).",
  inputSchema: {
    zone: z.string().optional().describe("Filter by zone name (partial match, e.g. 'kitchen')"),
    class: z.string().optional().describe("Filter by device class (e.g. light, sensor, thermostat, speaker, lock, socket)"),
  },
  annotations: READ,
}, async ({ zone, class: cls }) => {
  const api = await getHomeyApi();
  const zones = await api.zones.getZones();
  let devices = Object.values(await api.devices.getDevices()) as any[];
  if (zone) {
    const zl = zone.toLowerCase();
    devices = devices.filter((d) => zones[d.zone]?.name?.toLowerCase().includes(zl));
  }
  if (cls) {
    const cl = cls.toLowerCase();
    devices = devices.filter((d) => d.class?.toLowerCase().includes(cl));
  }
  return json({ total: devices.length, devices: devices.map((d) => fmtDevice(d, zones)) });
});

server.registerTool("get_device", {
  title: "Get Device Details",
  description: "Get detailed information about a specific device by ID, including all capability values, settings, and availability status. Use list_devices or search_devices first to find the device ID.",
  inputSchema: { id: z.string().describe("Device ID (UUID format)") },
  annotations: READ,
}, async ({ id }) => {
  const api = await getHomeyApi();
  const devices = await api.devices.getDevices();
  const d = devices[id];
  if (!d) return err(`Device ${id} not found`);
  const zones = await api.zones.getZones();
  return json(fmtDevice(d, zones));
});

server.registerTool("search_devices", {
  title: "Search Devices",
  description: "Search devices by name, device class, or capability name. Returns matching devices with their current values. Useful for finding devices when you don't know the exact ID — e.g. search 'temperature' to find all temperature sensors, or 'kitchen' to find devices with kitchen in the name.",
  inputSchema: { query: z.string().describe("Search text (matches against device name, class, and capability names)") },
  annotations: READ,
}, async ({ query }) => {
  const api = await getHomeyApi();
  const zones = await api.zones.getZones();
  const devices = Object.values(await api.devices.getDevices()) as any[];
  const q = query.toLowerCase();
  const matches = devices.filter((d) =>
    d.name?.toLowerCase().includes(q) ||
    d.class?.toLowerCase().includes(q) ||
    d.capabilities?.some((c: string) => c.toLowerCase().includes(q))
  );
  return json({ query, total: matches.length, devices: matches.map((d) => fmtDevice(d, zones)) });
});

server.registerTool("set_device_capability", {
  title: "Control Device",
  description: "Control a device by setting a capability value. Common capabilities: 'onoff' (boolean — turn on/off), 'dim' (number 0-1 — brightness), 'target_temperature' (number — thermostat setpoint), 'volume_set' (number 0-1). Use get_device first to see available capabilities and their current values.",
  inputSchema: {
    deviceId: z.string().describe("Device ID"),
    capability: z.string().describe("Capability ID (e.g. onoff, dim, target_temperature, volume_set)"),
    value: z.union([z.boolean(), z.number(), z.string()]).describe("Value to set (type depends on capability)"),
  },
  annotations: WRITE,
}, async ({ deviceId, capability, value }) => {
  const api = await getHomeyApi();
  const devices = await api.devices.getDevices();
  const device = devices[deviceId];
  if (!device) return err(`Device ${deviceId} not found`);
  await device.setCapabilityValue({ capabilityId: capability, value });
  return json({ success: true, device: device.name, capability, value });
});

// ── Zones ────────────────────────────────────────────────────────────

server.registerTool("list_zones", {
  title: "List Zones",
  description: "List all zones (rooms/areas) in the home with their hierarchy. Returns zone ID, name, parent zone, and icon. Zones are organized in a tree: Home → Floors → Rooms.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const zones = Object.values(await api.zones.getZones()) as any[];
  return json({ total: zones.length, zones: zones.map((z) => ({ id: z.id, name: z.name, parent: z.parent, icon: z.icon, active: z.active })) });
});

// ── Flows ────────────────────────────────────────────────────────────

server.registerTool("list_flows", {
  title: "List Flows",
  description: "List all automation flows (simple and advanced). Returns flow ID, name, enabled/broken status, and type. Flows are Homey's automations with WHEN/AND/THEN logic.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const flows = Object.values(await api.flow.getFlows()) as any[];
  let advancedFlows: any[] = [];
  try { advancedFlows = Object.values(await api.flow.getAdvancedFlows()) as any[]; } catch { /* may not be available */ }
  let folders: Record<string, any> = {};
  try { folders = await api.flow.getFlowFolders(); } catch { /* older firmware */ }
  const folderName = (f: any) => folders[f.folder]?.name ?? null;
  return json({
    flows: flows.map((f) => ({ id: f.id, name: f.name, folder: folderName(f), enabled: f.enabled, broken: f.broken, type: "simple" })),
    advancedFlows: advancedFlows.map((f) => ({ id: f.id, name: f.name, folder: folderName(f), enabled: f.enabled, broken: f.broken, type: "advanced" })),
  });
});

// Homey resolves a token reference as `<ownerUri>|<tokenId>` (pipe). A reference
// written `<ownerUri>:<tokenId>` (colon) is accepted by the API, never flagged as
// broken, and fails at run time with "Missing token value" — the condition then
// silently stops the flow. Found on 2026-09-06 in ~70 conditions here.
const MALFORMED_DROPTOKEN = "token reference uses ':' instead of '|' (ownerUri|tokenId); Homey cannot resolve it and this card never passes — fix with audit_flows/updateFlow";
// A simple-flow action without `group` runs on the ELSE path as well as the THEN
// path, i.e. regardless of the AND conditions. The app always writes
// `group: "then"`; API-created flows often omit it. Verified 2026-09-06 with
// real triggers: then-only actions gate correctly, group-less ones do not.
const MISSING_ACTION_GROUP = "action has no `group`; Homey runs it whether the AND conditions are true or false — set group: \"then\" (or \"else\")";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

server.registerTool("audit_flows", {
  title: "Audit Flows",
  description: "Scan every flow for silent defects Homey does not flag as broken: actions without a `group` (they run whether the AND conditions are true or false), token references with the wrong separator (the condition errors and the flow aborts), autocomplete arguments stored as plain strings (never match), references to missing or unavailable devices, missing logic variables, disabled flows, and trigger arguments the current flow card no longer declares (stale after an app update). Read-only. Returns findings grouped by kind with flow names and ids; fix token references by re-saving the flow with `ownerUri|tokenId`.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const [flows, devices, variables] = await Promise.all([api.flow.getFlows(), api.devices.getDevices(), api.logic.getVariables()]);
  const out = { total: Object.keys(flows).length, broken: [] as any[], disabled: [] as any[], actionsWithoutGroup: [] as any[], malformedTokenReferences: [] as any[], plainAutocompleteArgs: [] as any[], missingDevices: [] as any[], unavailableDevices: [] as any[], missingVariables: [] as any[], staleTriggerArgs: [] as any[] };
  const cardDefs = new Map<string, any>();
  for (const f of Object.values(flows) as any[]) {
    const ref = { id: f.id, name: f.name };
    if (f.broken) out.broken.push(ref);
    if (!f.enabled) out.disabled.push(ref);
    const cards = [["when", f.trigger], ...(f.conditions ?? []).map((c: any) => ["and", c]), ...(f.actions ?? []).map((a: any) => ["then", a])] as [string, any][];
    for (const [kind, c] of cards) {
      if (!c) continue;
      if (kind === "then" && !c.group) out.actionsWithoutGroup.push({ ...ref, action: c.id });
      if (typeof c.droptoken === "string" && !c.droptoken.includes("|")) out.malformedTokenReferences.push({ ...ref, card: kind, droptoken: c.droptoken });
      // autocomplete args must be the object the card's autocomplete returned; a plain string never matches
      if (c.id && c.args) {
        const key = `${kind}:${c.id}`;
        if (!cardDefs.has(key)) {
          const uri = c.uri ?? c.id.split(":").slice(0, -1).join(":");
          const getter = kind === "when" ? api.flow.getFlowCardTrigger : kind === "and" ? api.flow.getFlowCardCondition : api.flow.getFlowCardAction;
          cardDefs.set(key, await getter.call(api.flow, { uri, id: c.id }).catch(() => null));
        }
        const def = cardDefs.get(key);
        for (const a of def?.args ?? []) {
          const v = c.args[a.name];
          if (a.type === "autocomplete" && v !== undefined && (typeof v !== "object" || v === null)) out.plainAutocompleteArgs.push({ ...ref, card: kind, cardId: c.id, arg: a.name, value: v });
        }
      }
      for (const s of [c.uri, c.id, c.droptoken, ...Object.values(c.args ?? {}).filter((v) => typeof v === "string")] as string[]) {
        if (!s) continue;
        for (const m of s.matchAll(/homey:device:([0-9a-f-]{36})/g)) {
          const d = devices[m[1]];
          if (!d) out.missingDevices.push({ ...ref, card: kind, deviceId: m[1] });
          else if (d.available === false) out.unavailableDevices.push({ ...ref, card: kind, device: d.name });
        }
        for (const m of s.matchAll(/homey:manager:logic[|:]([0-9a-f-]{36})/g)) if (!(variables as any)[m[1]]) out.missingVariables.push({ ...ref, card: kind, variableId: m[1] });
      }
    }
    // stale trigger args: compare against the card definition the app currently publishes
    const t = f.trigger;
    if (t?.id && t.args && Object.keys(t.args).length) {
      const def = cardDefs.get(`when:${t.id}`);
      if (def?.args) {
        const declared = new Set(def.args.map((a: any) => a.name));
        const stale = Object.keys(t.args).filter((k) => !declared.has(k));
        if (stale.length) out.staleTriggerArgs.push({ ...ref, trigger: t.id, staleArgs: stale, declared: [...declared] });
      }
    }
  }
  // dedupe device/variable findings per flow
  const uniq = (arr: any[]) => Array.from(new Map(arr.map((x) => [JSON.stringify(x), x])).values());
  out.missingDevices = uniq(out.missingDevices); out.unavailableDevices = uniq(out.unavailableDevices); out.missingVariables = uniq(out.missingVariables);
  const summary = Object.fromEntries(Object.entries(out).filter(([k]) => k !== "total").map(([k, v]) => [k, (v as any[]).length]));
  return json({ summary, ...out });
});

server.registerTool("get_flow", {
  title: "Get Flow Definition",
  description: "Get a flow's full WHEN/AND/THEN definition with device, zone and logic-variable references resolved to names. Each card shows its card id, arguments, the token it compares against (droptoken), whether it is inverted, and any delay. Use this to audit what a flow actually does — list_flows only returns names. Works for simple flows; advanced flows return their raw card graph.",
  inputSchema: { id: z.string().describe("Flow ID (from list_flows)") },
  annotations: READ,
}, async ({ id }) => {
  const api = await getHomeyApi();
  const [devices, zones, variables] = await Promise.all([api.devices.getDevices(), api.zones.getZones(), api.logic.getVariables()]);
  let folders: Record<string, any> = {};
  try { folders = await api.flow.getFlowFolders(); } catch { /* older firmware */ }
  // Resolve every UUID inside a URI/token string to "<uuid> (Name)".
  const resolve = (s: unknown): unknown => typeof s === "string"
    ? s.replace(UUID_RE, (u) => {
        const hit = devices[u]?.name ?? zones[u]?.name ?? (variables as any)[u]?.name;
        return hit ? `${u} (${hit})` : u;
      })
    : s;
  const card = (c: any, isAction = false) => {
    if (!c) return null;
    const out: Record<string, unknown> = { id: resolve(c.id), uri: resolve(c.uri) };
    if (c.args && Object.keys(c.args).length) out.args = c.args;
    if (c.droptoken) {
      out.droptoken = resolve(c.droptoken);
      if (!String(c.droptoken).includes("|")) out.warning = MALFORMED_DROPTOKEN;
    }
    if (c.inverted) out.inverted = true;
    if (c.group) out.group = c.group;
    else if (isAction) out.warning = MISSING_ACTION_GROUP;
    if (c.delay) out.delay = c.delay;
    if (c.duration) out.duration = c.duration;
    return out;
  };
  const flows = await api.flow.getFlows();
  const f = flows[id];
  if (f) {
    return json({
      id: f.id, name: f.name, type: "simple", folder: folders[f.folder]?.name ?? null,
      enabled: f.enabled, broken: f.broken, triggerable: f.triggerable,
      when: card(f.trigger), and: (f.conditions ?? []).map((c: any) => card(c)), then: (f.actions ?? []).map((a: any) => card(a, true)),
    });
  }
  try {
    const adv = (await api.flow.getAdvancedFlows())[id];
    if (adv) {
      const cards: Record<string, unknown> = {};
      for (const [k, c] of Object.entries(adv.cards ?? {})) cards[k] = { ...card(c), type: (c as any).type, outputSuccess: (c as any).outputSuccess, outputError: (c as any).outputError };
      return json({ id: adv.id, name: adv.name, type: "advanced", folder: folders[adv.folder]?.name ?? null, enabled: adv.enabled, broken: adv.broken, cards });
    }
  } catch { /* advanced flows unavailable */ }
  return err(`Flow ${id} not found`);
});

server.registerTool("trigger_flow", {
  title: "Trigger Flow",
  description: "Trigger (run) a flow immediately by its ID. Tries simple flow first, then advanced flow. Use list_flows to find the flow ID.",
  inputSchema: { id: z.string().describe("Flow ID") },
  annotations: WRITE,
}, async ({ id }) => {
  const api = await getHomeyApi();
  try { await api.flow.triggerFlow({ id }); return json({ success: true, id, type: "simple" }); } catch {
    try { await api.flow.triggerAdvancedFlow({ id }); return json({ success: true, id, type: "advanced" }); } catch (e: any) { return err(e.message); }
  }
});

server.registerTool("set_flow_enabled", {
  title: "Enable/Disable Flow",
  description: "Enable or disable a flow automation. Disabled flows won't trigger. Use list_flows to find the flow ID.",
  inputSchema: {
    id: z.string().describe("Flow ID"),
    enabled: z.boolean().describe("true to enable, false to disable"),
  },
  annotations: WRITE,
}, async ({ id, enabled }) => {
  const api = await getHomeyApi();
  try { await api.flow.updateFlow({ id, flow: { enabled } }); return json({ success: true, id, enabled, type: "simple" }); } catch {
    try { await api.flow.updateAdvancedFlow({ id, advancedflow: { enabled } }); return json({ success: true, id, enabled, type: "advanced" }); } catch (e: any) { return err(e.message); }
  }
});

// ── Logic Variables ──────────────────────────────────────────────────

server.registerTool("list_variables", {
  title: "List Logic Variables",
  description: "List all logic variables with their current values. Logic variables store state (boolean, number, string) that can be used in flow conditions and actions.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const vars = Object.values(await api.logic.getVariables()) as any[];
  return json({ total: vars.length, variables: vars.map((v) => ({ id: v.id, name: v.name, type: v.type, value: v.value })) });
});

server.registerTool("set_variable", {
  title: "Set Logic Variable",
  description: "Set the value of a logic variable. The value type must match the variable type (boolean, number, or string).",
  inputSchema: {
    id: z.string().describe("Variable ID"),
    value: z.union([z.boolean(), z.number(), z.string()]).describe("New value (must match variable type)"),
  },
  annotations: WRITE,
}, async ({ id, value }) => {
  const api = await getHomeyApi();
  await api.logic.updateVariable({ id, variable: { value } });
  return json({ success: true, id, value });
});

// ── Apps ─────────────────────────────────────────────────────────────

server.registerTool("list_apps", {
  title: "List Installed Apps",
  description: "List all installed Homey apps with version, enabled status, and origin (appstore or devkit). Apps provide device drivers, flow cards, and integrations.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const apps = Object.values(await api.apps.getApps()) as any[];
  return json({ total: apps.length, apps: apps.map((a) => ({ id: a.id, name: a.name, version: a.version, enabled: a.enabled, origin: a.origin })) });
});

server.registerTool("restart_app", {
  title: "Restart App",
  description: "Restart a Homey app. Useful when devices from that app are unresponsive. Use list_apps to find the app ID (e.g. 'com.fibaro').",
  inputSchema: { id: z.string().describe("App ID (e.g. com.fibaro, nl.philips.hue)") },
  annotations: WRITE,
}, async ({ id }) => {
  const api = await getHomeyApi();
  await api.apps.restartApp({ id });
  return json({ success: true, id });
});

server.registerTool("enable_app", {
  title: "Enable/Disable App",
  description: "Enable or disable a Homey app. Disabled apps won't run and their devices become unavailable.",
  inputSchema: {
    id: z.string().describe("App ID"),
    enabled: z.boolean().describe("true to enable, false to disable"),
  },
  annotations: WRITE,
}, async ({ id, enabled }) => {
  const api = await getHomeyApi();
  if (enabled) await api.apps.enableApp({ id }); else await api.apps.disableApp({ id });
  return json({ success: true, id, enabled });
});

server.registerTool("uninstall_app", {
  title: "Uninstall App",
  description: "Permanently uninstall a Homey app and remove all its devices. This cannot be undone.",
  inputSchema: { id: z.string().describe("App ID") },
  annotations: DESTRUCTIVE,
}, async ({ id }) => {
  const api = await getHomeyApi();
  await api.apps.uninstallApp({ id });
  return json({ success: true, id });
});

// ── HomeyScript ──────────────────────────────────────────────────────
// Requires the HomeyScript app (com.athom.homeyscript) to be installed.
// Exposes the app's internal REST routes via api.call:
//   GET    /api/app/com.athom.homeyscript/script          — list
//   GET    /api/app/com.athom.homeyscript/script/:id      — read
//   PUT    /api/app/com.athom.homeyscript/script/:id      — create/update
//   POST   /api/app/com.athom.homeyscript/script/:id/run  — execute stored script
//   DELETE /api/app/com.athom.homeyscript/script/:id      — delete

const HOMEYSCRIPT_BASE = "/api/app/com.athom.homeyscript";

server.registerTool("list_scripts", {
  title: "List HomeyScripts",
  description: "List all HomeyScript scripts. Returns id, name, version, and last execution time. HomeyScript lets you run JavaScript against the Homey API from a flow or on demand.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const scripts = await api.call({ method: "GET", path: `${HOMEYSCRIPT_BASE}/script` });
  const arr = Object.values(scripts) as Array<{ id: string; name: string; version?: number; lastExecuted?: string | null }>;
  return json({
    total: arr.length,
    scripts: arr.map((s) => ({ id: s.id, name: s.name, version: s.version, lastExecuted: s.lastExecuted })),
  });
});

server.registerTool("get_script", {
  title: "Get HomeyScript",
  description: "Get a HomeyScript's full source code and metadata. Use list_scripts to discover IDs.",
  inputSchema: { id: z.string().describe("Script ID (slug or UUID)") },
  annotations: READ,
}, async ({ id }) => {
  const api = await getHomeyApi();
  try {
    const script = await api.call({ method: "GET", path: `${HOMEYSCRIPT_BASE}/script/${encodeURIComponent(id)}` });
    return json(script);
  } catch (e: any) {
    return err(`Script ${id} not found: ${e.message}`);
  }
});

server.registerTool("upsert_script", {
  title: "Create/Update HomeyScript",
  description: "Create a new HomeyScript or overwrite an existing one. Pass the `id` of an existing script to update it, or omit `id` to create a new script (the server assigns a UUID). HomeyScript code runs in a sandboxed environment with access to the global `Homey` API object and `log()`. Return a value with `return <x>` to expose it to the calling flow.",
  inputSchema: {
    id: z.string().optional().describe("Existing script ID to update. Omit to create a new script — the server will assign a UUID."),
    name: z.string().describe("Human-readable script name"),
    code: z.string().describe("JavaScript source code. Has access to the `Homey` API global, `log()`, and standard async/await."),
  },
  annotations: WRITE,
}, async ({ id, name, code }) => {
  const api = await getHomeyApi();
  if (id) {
    const result = await api.call({
      method: "PUT",
      path: `${HOMEYSCRIPT_BASE}/script/${encodeURIComponent(id)}`,
      body: { name, code },
    });
    return json({ success: true, action: "updated", id, ...result });
  }
  const result = await api.call({
    method: "POST",
    path: `${HOMEYSCRIPT_BASE}/script`,
    body: { name, code },
  });
  return json({ success: true, action: "created", ...result });
});

server.registerTool("run_script", {
  title: "Run HomeyScript",
  description: "Execute a stored HomeyScript and return its result. Returns `{ success, returns }` where `returns` is the script's return value, or `{ success: false, returns: { message, stack } }` on failure.",
  inputSchema: {
    id: z.string().describe("Script ID to run"),
    argument: z.string().optional().describe("Optional argument string passed to the script as `args[0]`"),
  },
  annotations: WRITE,
}, async ({ id, argument }) => {
  const api = await getHomeyApi();
  const result = await api.call({
    method: "POST",
    path: `${HOMEYSCRIPT_BASE}/script/${encodeURIComponent(id)}/run`,
    body: argument !== undefined ? { argument } : {},
    // HomeyScripts that actuate slow cloud devices (e.g. a Panasonic AC whose
    // setCapabilityValue round-trips ~7.5s) can legitimately run well past the
    // client's 10s default fetch timeout while completing fine server-side.
    // Give run a 60s ceiling so the tool returns the real result, not a 408.
    $timeout: 60000,
  });
  return json(result);
});

server.registerTool("delete_script", {
  title: "Delete HomeyScript",
  description: "Permanently delete a HomeyScript. Any flows still referencing it will become broken.",
  inputSchema: { id: z.string().describe("Script ID to delete") },
  annotations: DESTRUCTIVE,
}, async ({ id }) => {
  const api = await getHomeyApi();
  await api.call({ method: "DELETE", path: `${HOMEYSCRIPT_BASE}/script/${encodeURIComponent(id)}` });
  return json({ success: true, id });
});


// ── Insights ─────────────────────────────────────────────────────────

server.registerTool("list_insights", {
  title: "List Insight Logs",
  description: "List all available insight logs (sensor history, energy meters, etc). Returns log ID, title, data type, and units. Use the log ID with get_insight_entries to retrieve historical data.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const logs = Object.values(await api.insights.getLogs()) as any[];
  return json({ total: logs.length, logs: logs.map((l) => ({ id: l.id, title: l.title, type: l.type, units: l.units })) });
});

server.registerTool("get_insight_entries", {
  title: "Get Insight History",
  description: "Get historical data points for an insight log. Returns timestamped values (e.g. temperature readings over time). Use list_insights first to find the log ID.",
  inputSchema: {
    id: z.string().describe("Insight log ID (from list_insights)"),
    resolution: z.enum(["last6Hours", "last24Hours", "last7Days", "last14Days", "last31Days", "last3Months", "lastYear"]).optional().describe("Time range (default: last24Hours)"),
  },
  annotations: READ,
}, async ({ id, resolution }) => {
  const api = await getHomeyApi();
  const entries = await api.insights.getLogEntries({ id, resolution: resolution ?? "last24Hours" });
  return json({ id, resolution: resolution ?? "last24Hours", entries: entries.values?.length ?? 0, values: entries.values });
});

// ── Energy ───────────────────────────────────────────────────────────

server.registerTool("get_energy_live", {
  title: "Live Energy Report",
  description: "Get real-time power consumption broken down by zone and device. Returns watts (W) currently being consumed. Useful for answering 'what is using power right now?'",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  return json(await api.energy.getLiveReport());
});

server.registerTool("get_energy_report", {
  title: "Energy Report",
  description: "Get energy consumption report for a specific period. Returns kWh consumed per device. Useful for 'how much energy did I use today/this week/this month?'",
  inputSchema: {
    period: z.enum(["day", "week", "month", "year"]).describe("Report period"),
    date: z.string().optional().describe("Date in YYYY-MM-DD format (default: today)"),
  },
  annotations: READ,
}, async ({ period, date }) => {
  const api = await getHomeyApi();
  const d = date ?? new Date().toISOString().split("T")[0];
  const fn = { day: "getReportDay", week: "getReportWeek", month: "getReportMonth", year: "getReportYear" }[period];
  return json(await api.energy[fn]({ date: d }));
});

// ── Weather ──────────────────────────────────────────────────────────

server.registerTool("get_weather", {
  title: "Current Weather",
  description: "Get current weather conditions at Homey's location. Returns temperature, humidity, pressure, wind, and weather state (e.g. 'clear sky', 'overcast clouds').",
  annotations: { ...READ, openWorldHint: true },
}, async () => {
  const api = await getHomeyApi();
  const w = await api.weather.getWeather();
  const { screensaver: _screensaver, ...weather } = w;
  return json(weather);
});

server.registerTool("get_weather_hourly", {
  title: "Hourly Weather Forecast",
  description: "Get hourly weather forecast at Homey's location. Returns temperature and weather conditions for upcoming hours.",
  annotations: { ...READ, openWorldHint: true },
}, async () => {
  const api = await getHomeyApi();
  return json(await api.weather.getWeatherHourly());
});

// ── Presence ─────────────────────────────────────────────────────────

server.registerTool("get_presence", {
  title: "Get Presence Status",
  description: "Get home/away and awake/asleep status for all household members. Useful for 'is anyone home?' or 'who is home?'",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const users = Object.values(await api.users.getUsers()) as any[];
  return json({ users: users.map((u) => ({ id: u.id, name: u.name, present: u.present, asleep: u.asleep, role: u.role })) });
});

server.registerTool("set_presence", {
  title: "Set Presence",
  description: "Set your own presence (home/away) or sleep state (awake/asleep). This affects presence-based automations.",
  inputSchema: {
    present: z.boolean().optional().describe("true = home, false = away"),
    asleep: z.boolean().optional().describe("true = asleep, false = awake"),
  },
  annotations: WRITE,
}, async ({ present, asleep }) => {
  const api = await getHomeyApi();
  if (present !== undefined) await api.presence.setPresentMe({ present });
  if (asleep !== undefined) await api.presence.setAsleepMe({ asleep });
  return json({ success: true, present, asleep });
});

// ── Notifications ────────────────────────────────────────────────────

server.registerTool("list_notifications", {
  title: "List Notifications",
  description: "List the 50 most recent Homey notifications (app updates, alerts, system messages). Sorted newest first.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const notifs = Object.values(await api.notifications.getNotifications()) as any[];
  const sorted = notifs.sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime()).slice(0, 50);
  return json({ total: notifs.length, showing: sorted.length, notifications: sorted.map((n) => ({ id: n.id, excerpt: n.excerpt, dateCreated: n.dateCreated })) });
});

server.registerTool("create_notification", {
  title: "Send Notification",
  description: "Send a notification to the Homey timeline. Visible in the Homey app for all household members.",
  inputSchema: { excerpt: z.string().describe("Notification message text") },
  annotations: WRITE,
}, async ({ excerpt }) => {
  const api = await getHomeyApi();
  // homey-api's web client exposes no notifications.createNotification (only
  // the HomeyScript sandbox and flows can post), so run the built-in flow-card
  // action instead — the same route the deployed Season Controller uses.
  await api.flow.runFlowCardAction({
    uri: "homey:manager:notifications",
    id: "homey:manager:notifications:create_notification",
    args: { text: excerpt },
  });
  return json({ success: true, excerpt });
});

// ── Alarms ───────────────────────────────────────────────────────────

server.registerTool("list_alarms", {
  title: "List Alarms",
  description: "List all alarms and timers with their schedule and repetition days.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const alarms = Object.values(await api.alarms.getAlarms()) as any[];
  return json({ total: alarms.length, alarms: alarms.map((a) => ({ id: a.id, name: a.name, time: a.time, enabled: a.enabled, repetition: a.repetition })) });
});

server.registerTool("set_alarm", {
  title: "Create/Update Alarm",
  description: "Create a new alarm or update an existing one. Specify time in HH:MM format and optionally which days to repeat.",
  inputSchema: {
    id: z.string().optional().describe("Alarm ID (omit to create new)"),
    name: z.string().describe("Alarm name"),
    time: z.string().describe("Time in HH:MM format (24h)"),
    enabled: z.boolean().optional().describe("Enable/disable (default: true)"),
    repetition: z.object({ mon: z.boolean().optional(), tue: z.boolean().optional(), wed: z.boolean().optional(), thu: z.boolean().optional(), fri: z.boolean().optional(), sat: z.boolean().optional(), sun: z.boolean().optional() }).optional().describe("Days to repeat"),
  },
  annotations: WRITE,
}, async ({ id, name, time, enabled, repetition }) => {
  const api = await getHomeyApi();
  const alarm = { name, time, enabled: enabled ?? true, repetition: repetition ?? {} };
  if (id) { await api.alarms.updateAlarm({ id, alarm }); return json({ success: true, action: "updated", id }); }
  const created = await api.alarms.createAlarm({ alarm });
  return json({ success: true, action: "created", id: created.id });
});

server.registerTool("delete_alarm", {
  title: "Delete Alarm",
  description: "Permanently delete an alarm. Use list_alarms to find the alarm ID.",
  inputSchema: { id: z.string().describe("Alarm ID") },
  annotations: DESTRUCTIVE,
}, async ({ id }) => {
  const api = await getHomeyApi();
  await api.alarms.deleteAlarm({ id });
  return json({ success: true, id });
});

// ── Moods ────────────────────────────────────────────────────────────

server.registerTool("list_moods", {
  title: "List Moods",
  description: "List all moods (scenes/presets) per zone. Moods save device states that can be activated together (e.g. 'Movie Mode' dims lights and closes blinds).",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const moods = Object.values(await api.moods.getMoods()) as any[];
  const zones = await api.zones.getZones();
  return json({ total: moods.length, moods: moods.map((m) => ({ id: m.id, name: m.name, zone: zones[m.zone]?.name ?? m.zone, zoneId: m.zone, devices: Object.keys(m.devices ?? {}).length })) });
});

server.registerTool("set_mood", {
  title: "Activate Mood",
  description: "Activate a mood (scene) in a zone. This sets all devices in the mood to their saved states.",
  inputSchema: {
    zoneId: z.string().describe("Zone ID"),
    moodId: z.string().describe("Mood ID"),
  },
  annotations: WRITE,
}, async ({ zoneId, moodId }) => {
  const api = await getHomeyApi();
  await api.moods.setMood({ zone: zoneId, mood: moodId });
  return json({ success: true, zoneId, moodId });
});

// ── System & Infrastructure ──────────────────────────────────────────

server.registerTool("get_system_info", {
  title: "System Information",
  description: "Get Homey system information including software version, hostname, Wi-Fi network, and hardware details.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  return json(await api.system.getInfo());
});

server.registerTool("get_location", {
  title: "Get Location",
  description: "Get Homey's configured geographic location (address and GPS coordinates). Used for sunrise/sunset calculations and weather.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const [address, location] = await Promise.all([
    api.geolocation.getOptionAddress().catch(() => null),
    api.geolocation.getOptionLocation().catch(() => null),
  ]);
  return json({ address, location });
});

server.registerTool("list_drivers", {
  title: "List Drivers",
  description: "List all available device drivers (protocol integrations). Useful for troubleshooting — shows which drivers are ready.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const drivers = Object.values(await api.drivers.getDrivers()) as any[];
  return json({ total: drivers.length, drivers: drivers.map((d) => ({ id: d.id, name: d.name, ready: d.ready })) });
});

server.registerTool("get_zwave_log", {
  title: "Z-Wave Log",
  description: "Get recent Z-Wave network log entries. Shows transmit failures, routing issues, and network events. Essential for diagnosing Z-Wave device connectivity problems.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  return json(await api.zwave.getLog());
});

server.registerTool("get_backup_status", {
  title: "Backup Status",
  description: "Get backup configuration and last successful backup timestamp.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const [autoEnabled, lastBackup] = await Promise.all([
    api.backup.getOptionAutomaticBackupsEnabled().catch(() => null),
    api.backup.getOptionLastSuccessfulBackup().catch(() => null),
  ]);
  return json({ automaticBackupsEnabled: autoEnabled?.value, lastSuccessfulBackup: lastBackup?.value });
});

server.registerTool("create_backup", {
  title: "Create Backup",
  description: "Schedule a new backup of the Homey configuration. Backup runs in the background.",
  annotations: WRITE,
}, async () => {
  const api = await getHomeyApi();
  await api.backup.scheduleBackup();
  return json({ success: true, message: "Backup scheduled" });
});

server.registerTool("get_ledring", {
  title: "LED Ring Status",
  description: "Get LED ring screensaver options and current setting.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const [screensavers, current] = await Promise.all([api.ledring.getScreensavers(), api.ledring.getOptionScreensaver().catch(() => null)]);
  return json({ current: current?.value, screensavers: Object.values(screensavers).map((s: any) => ({ id: s.id, name: s.name })) });
});

server.registerTool("set_ledring", {
  title: "Set LED Ring",
  description: "Set the LED ring screensaver animation. Use get_ledring to see available options (e.g. 'spectrum', 'off').",
  inputSchema: { screensaverId: z.string().describe("Screensaver ID (e.g. 'spectrum', 'off')") },
  annotations: WRITE,
}, async ({ screensaverId }) => {
  const api = await getHomeyApi();
  await api.ledring.setOptionScreensaver({ value: { uri: "homey:manager:ledring", id: screensaverId } });
  return json({ success: true, screensaverId });
});

server.registerTool("get_updates", {
  title: "Check Updates",
  description: "Check for available Homey system updates and current update settings (channel, auto-update).",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const [channel, autoupdate, updates] = await Promise.all([
    api.updates.getOptionChannel().catch(() => null),
    api.updates.getOptionAutoupdate().catch(() => null),
    api.updates.getUpdates().catch(() => []),
  ]);
  return json({ channel: channel?.value, autoupdate: autoupdate?.value, pendingUpdates: updates });
});

server.registerTool("get_session", {
  title: "Session Info",
  description: "Get current API session details including authenticated user, role, and permission scopes.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  const session = await api.sessions.getSessionMe();
  return json({ id: session.id, type: session.type, userId: session.userId, userName: session.userName, scopes: session.scopes });
});

server.registerTool("reboot_homey", {
  title: "Reboot Homey",
  description: "Reboot the Homey Pro. Takes 2-3 minutes to come back online. Use this to resolve stale devices or Z-Wave/Zigbee mesh issues after firmware updates.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}, async () => {
  const api = await getHomeyApi();
  await api.system.reboot();
  return json({ success: true, message: "Reboot initiated. Homey will be back in ~2-3 minutes." });
});

server.registerTool("get_memory_info", {
  title: "Memory Usage",
  description: "Get Homey memory usage breakdown by app and system component. Useful for identifying memory-hungry apps.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  return json(await api.system.getMemoryInfo());
});

server.registerTool("get_storage_info", {
  title: "Storage Usage",
  description: "Get Homey storage usage breakdown. Shows how much disk space is used by apps, insights, and system.",
  annotations: READ,
}, async () => {
  const api = await getHomeyApi();
  return json(await api.system.getStorageInfo());
});

server.registerTool("set_system_name", {
  title: "Set System Name",
  description: "Set the Homey system name (visible in network discovery and the Homey app).",
  inputSchema: { name: z.string().describe("New system name") },
  annotations: WRITE,
}, async ({ name }) => {
  const api = await getHomeyApi();
  await api.system.setSystemName({ name });
  return json({ success: true, name });
});


// ── Prompts ──────────────────────────────────────────────────────────

server.registerPrompt("homey_best_practices", {
  title: "Homey Best Practices",
  description: "Zone architecture, device naming, Z-Wave/Zigbee mesh tips, energy management, security, and performance guidelines.",
}, () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: `# Homey Pro Best Practices

## Zone Architecture
- Hierarchy: Home → Floors → Rooms → Sub-areas
- Every device in exactly one zone. Use sub-zones for independent control areas
- Consistent English naming (match Homey's language setting)

## Device Naming
- Pattern: \`<Type> [Location Detail]\` — e.g. "Ceiling Light", "Floor Thermostat", "Motion Sensor"
- Avoid hardware model names (not "Dimmer 2" or "ZW122")
- Avoid default names (not "Hue color lamp 1")

## Z-Wave Best Practices
- Mains-powered devices relay signals — place them between Homey and distant nodes
- Use S2 security for pairing. Run network heal after adding/moving devices
- Remove failed nodes promptly to prevent ghost routing issues
- Max 232 nodes per network

## Zigbee Best Practices
- Avoid Wi-Fi channel overlap (Zigbee channels 11, 15, 20, 25 are safest)
- Mains-powered devices act as routers. Battery devices are end-nodes only
- Keep first-hop routers within 5-10m of Homey

## Energy & Maintenance
- Enable energy reporting on all capable devices
- Keep automatic backups enabled. Manual backup before major changes
- Review weekly energy reports. Set up standby detection flows
- Periodic app audit — remove unused apps to free resources
- Consider weekly scheduled reboot for long-term stability

## Security
- Use scoped API keys with minimum permissions
- Role-based access: owner, manager, user, guest
- Enable notifications for security events (door sensors, motion, water alarms)` }}] }));

server.registerPrompt("homey_troubleshooting", {
  title: "Homey Troubleshooting",
  description: "Diagnosing offline devices, Z-Wave/Zigbee issues, flow debugging, and performance problems.",
}, () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: `# Homey Troubleshooting Guide

## Device Unavailable
1. Check power and physical status
2. Check distance — may be out of range
3. Z-Wave: check get_zwave_log for TRANSMIT_COMPLETE_NO_ACK errors
4. Zigbee: verify nearby router devices are online
5. Try: restart_app for the device's app
6. Try: reboot_homey to rebuild mesh
7. Last resort: remove and re-pair

## Z-Wave Issues
- Transmit failures → add mains-powered repeaters between Homey and device
- Ghost nodes → remove failed nodes via Developer Tools
- "Invalid Node Token" → battery dead or security handshake broken. Replace battery, remove, re-pair
- Slow response → move Homey away from metal/interference sources

## Zigbee Issues
- Devices dropping → Wi-Fi interference. Change Zigbee channel
- Pairing fails → factory reset device, bring within 0.5m of Homey
- Battery drain → check reporting intervals (too frequent = fast drain)

## Flow Issues
- Not triggering → check enabled status, trigger conditions, device availability
- Actions fail → check target device availability and capability values
- Use list_flows to audit, trigger_flow to test manually

## Performance
- Slow UI → check get_memory_info for memory-hungry apps
- Storage full → check get_storage_info
- After firmware update → reboot_homey to rebuild protocol meshes` }}] }));

server.registerPrompt("homey_flow_patterns", {
  title: "Homey Flow Patterns",
  description: "Automation patterns for presence, lighting, climate, notifications, and common anti-patterns to avoid.",
}, () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: `# Homey Flow Patterns

## Naming Convention
Pattern: \`<Zone> — <Action>\` (e.g. "Kitchen — Motion Light On", "Garden — Lights Off at Sunrise")

## Folder Organization
Group by function: Lighting, Climate, Security, Bathroom, Buttons

## Common Patterns

### Motion Lighting
- WHEN motion detected AND light is off AND time between sunset-sunrise
- THEN turn on light, start countdown timer
- Separate flow: WHEN countdown reaches zero THEN turn off light
- Add "manual override" variable to skip auto-off when manually turned on

### Presence Automation
- WHEN last person leaves → turn off lights, lower thermostats
- WHEN first person arrives → restore comfort settings
- Guard with "vacation mode" variable

### Climate Schedule
- Morning: raise target temperature
- Evening: lower target temperature
- Night: turn off or set to minimum
- Always check presence — don't heat empty rooms

### Sunrise/Sunset
- Use Homey's built-in sun events, not fixed times
- Add offsets: "30 min before sunset" for gradual transitions
- Combine with presence checks

## Anti-Patterns to Avoid
- Polling loops (check state every X seconds) → use event triggers instead
- Mega-flows with 20+ actions → split into focused sub-flows
- Hardcoded times → use sunrise/sunset + presence
- Missing conditions → always guard with time-of-day and presence
- Duplicate flow names → use Zone — Action pattern` }}] }));

// ── Start ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
