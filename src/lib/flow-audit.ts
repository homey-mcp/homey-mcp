// Pure flow analysis for audit_flows and get_flow. The Homey calls live in
// index.ts; everything here works on plain data so it can be tested.

// Homey resolves a token reference as `<ownerUri>|<tokenId>` (pipe). A reference
// written `<ownerUri>:<tokenId>` (colon) is accepted by the API, never flagged as
// broken, and fails at run time with "Missing token value", so the condition
// silently stops the flow.
export const MALFORMED_DROPTOKEN = "token reference uses ':' instead of '|' (ownerUri|tokenId); Homey cannot resolve it and this card never passes — fix with audit_flows/updateFlow";
// A simple-flow action without `group` runs on the ELSE path as well as the THEN
// path, i.e. regardless of the AND conditions. The app always writes
// `group: "then"`; API-created flows often omit it. Verified with real
// triggers: then-only actions gate correctly, group-less ones do not.
export const MISSING_ACTION_GROUP = "action has no `group`; Homey runs it whether the AND conditions are true or false — set group: \"then\" (or \"else\")";

export type Kind = "when" | "and" | "then";
type Dict = Record<string, any>;

const ADVANCED_KIND: Record<string, Kind> = { trigger: "when", condition: "and", action: "then" };

/** Every flow card with its kind. Advanced-flow cards that are not
 *  trigger/condition/action (notes, delays, start blocks) are skipped. */
export function flowCards(flow: Dict, type: "simple" | "advanced"): [Kind, Dict][] {
  if (type === "advanced") {
    return Object.values(flow.cards ?? {})
      .filter((c: any) => c && ADVANCED_KIND[c.type])
      .map((c: any) => [ADVANCED_KIND[c.type], c] as [Kind, Dict]);
  }
  return [
    ...(flow.trigger ? [["when", flow.trigger] as [Kind, Dict]] : []),
    ...(flow.conditions ?? []).map((c: Dict) => ["and", c] as [Kind, Dict]),
    ...(flow.actions ?? []).map((a: Dict) => ["then", a] as [Kind, Dict]),
  ].filter(([, c]) => c);
}

export interface CardDefRequest { key: string; kind: Kind; uri: string; id: string }

export const cardUri = (c: Dict): string => c.uri ?? c.ownerUri ?? String(c.id).split(":").slice(0, -1).join(":");

/** One definition lookup per unique (kind, card id), across all flows. */
export function cardDefRequests(flows: Dict, advancedFlows: Dict): CardDefRequest[] {
  const out = new Map<string, CardDefRequest>();
  const add = (f: Dict, type: "simple" | "advanced") => {
    for (const [kind, c] of flowCards(f, type)) {
      if (typeof c.id !== "string") continue;
      const key = `${kind}:${c.id}`;
      if (!out.has(key)) out.set(key, { key, kind, uri: cardUri(c), id: c.id });
    }
  };
  for (const f of Object.values(flows)) add(f, "simple");
  for (const f of Object.values(advancedFlows)) add(f, "advanced");
  return [...out.values()];
}

/** Run `fn` over `items` with at most `limit` calls in flight; results keep
 *  the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function* strings(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

export interface AuditInput {
  flows: Dict;
  advancedFlows: Dict;
  devices: Dict;
  variables: Dict;
  /** HomeyScript scripts by id, or null when HomeyScript is not available. */
  scripts: Dict | null;
  /** Card definitions by `${kind}:${cardId}`; null or absent when unavailable. */
  cardDefs: Map<string, any>;
}

export function auditFlows({ flows, advancedFlows, devices, variables, scripts, cardDefs }: AuditInput) {
  const out = {
    broken: [] as any[], disabled: [] as any[], actionsWithoutGroup: [] as any[], malformedTokenReferences: [] as any[],
    plainAutocompleteArgs: [] as any[], nonStringTextArgs: [] as any[], missingRequiredArgs: [] as any[],
    mixedConditionGroups: [] as any[], missingDevices: [] as any[], unavailableDevices: [] as any[],
    missingVariables: [] as any[], missingScripts: [] as any[], missingFlows: [] as any[], staleTriggerArgs: [] as any[],
  };
  const allFlowIds = new Set([...Object.keys(flows), ...Object.keys(advancedFlows)]);

  const auditOne = (f: Dict, type: "simple" | "advanced") => {
    const ref = { id: f.id, name: f.name, type };
    if (f.broken) out.broken.push(ref);
    if (f.enabled === false) out.disabled.push(ref);

    if (type === "simple") {
      const conds: Dict[] = f.conditions ?? [];
      const grouped = conds.filter((c) => c?.group).length;
      if (grouped && grouped < conds.length) out.mixedConditionGroups.push({ ...ref, grouped, ungrouped: conds.length - grouped });
    }

    for (const [kind, c] of flowCards(f, type)) {
      const args: Dict = c.args ?? {};
      if (type === "simple" && kind === "then" && !c.group) out.actionsWithoutGroup.push({ ...ref, action: c.id });
      if (typeof c.droptoken === "string" && !c.droptoken.includes("|")) out.malformedTokenReferences.push({ ...ref, card: kind, droptoken: c.droptoken });

      const def = typeof c.id === "string" ? cardDefs.get(`${kind}:${c.id}`) : undefined;
      for (const a of def?.args ?? []) {
        const v = args[a.name];
        const at = { ...ref, card: kind, cardId: c.id, arg: a.name };
        // autocomplete args must be the object the card's autocomplete returned; a plain string never matches
        if (a.type === "autocomplete" && v !== undefined && (typeof v !== "object" || v === null)) out.plainAutocompleteArgs.push({ ...at, value: v });
        // a number in a text arg is rejected when the card runs (e.g. a countdown that never starts)
        if (a.type === "text" && typeof v === "number") out.nonStringTextArgs.push({ ...at, value: v });
        // required unless marked optional, a checkbox, or the card supplies a default value
        if (v === undefined && a.required !== false && a.type !== "checkbox" && a.value === undefined) out.missingRequiredArgs.push({ ...at, argType: a.type });
      }
      if (kind === "when" && def?.args && Object.keys(args).length) {
        const declared = new Set(def.args.map((a: any) => a.name));
        const stale = Object.keys(args).filter((k) => !declared.has(k));
        if (stale.length) out.staleTriggerArgs.push({ ...ref, trigger: c.id, staleArgs: stale, declared: [...declared] });
      }

      // references held as objects: logic variable, HomeyScript script, target flow
      const id = String(c.id ?? "");
      const varId = args.variable?.id;
      if (id.startsWith("homey:manager:logic:") && typeof varId === "string" && !variables[varId]) out.missingVariables.push({ ...ref, card: kind, variableId: varId });
      const scriptRef = args.script?.id;
      if (scripts && id.startsWith("homey:app:com.athom.homeyscript:") && typeof scriptRef === "string" && !scripts[scriptRef]) out.missingScripts.push({ ...ref, card: kind, scriptId: scriptRef, scriptName: args.script?.name });
      const flowRef = args.flow?.id;
      if (id.startsWith("homey:manager:flow:") && typeof flowRef === "string" && !allFlowIds.has(flowRef)) out.missingFlows.push({ ...ref, card: kind, flowId: flowRef, flowName: args.flow?.name });

      // references inside strings anywhere in the card
      for (const s of strings([c.uri, c.id, c.droptoken, args])) {
        for (const m of s.matchAll(/homey:device:([0-9a-f-]{36})/g)) {
          const d = devices[m[1]];
          if (!d) out.missingDevices.push({ ...ref, card: kind, deviceId: m[1] });
          else if (d.available === false) out.unavailableDevices.push({ ...ref, card: kind, device: d.name });
        }
        for (const m of s.matchAll(/homey:manager:logic[|:]([0-9a-f-]{36})/g)) if (!variables[m[1]]) out.missingVariables.push({ ...ref, card: kind, variableId: m[1] });
      }
    }
  };
  for (const f of Object.values(flows)) auditOne(f, "simple");
  for (const f of Object.values(advancedFlows)) auditOne(f, "advanced");

  // dedupe reference findings per flow and card kind
  const uniq = (arr: any[]) => Array.from(new Map(arr.map((x) => [JSON.stringify(x), x])).values());
  for (const k of ["missingDevices", "unavailableDevices", "missingVariables", "missingScripts", "missingFlows"] as const) out[k] = uniq(out[k]);

  const summary = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
  return { summary, total: Object.keys(flows).length, advancedTotal: Object.keys(advancedFlows).length, scriptsChecked: scripts !== null, ...out };
}

/** One card for get_flow, with references resolved and every warning kept. */
export function describeCard(c: Dict | null | undefined, isAction: boolean, resolve: (s: unknown) => unknown): Dict | null {
  if (!c) return null;
  const out: Dict = { id: resolve(c.id), uri: resolve(c.uri) };
  const warnings: string[] = [];
  if (c.args && Object.keys(c.args).length) out.args = c.args;
  if (c.droptoken) {
    out.droptoken = resolve(c.droptoken);
    if (!String(c.droptoken).includes("|")) warnings.push(MALFORMED_DROPTOKEN);
  }
  if (c.inverted) out.inverted = true;
  if (c.group) out.group = c.group;
  else if (isAction) warnings.push(MISSING_ACTION_GROUP);
  if (c.delay) out.delay = c.delay;
  if (c.duration) out.duration = c.duration;
  if (warnings.length) out.warnings = warnings;
  return out;
}
