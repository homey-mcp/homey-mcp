import { z } from "zod";

// homey-api substitutes path parameters into its URL templates without
// encoding them, so an id such as "../../system/reboot?x=" would reach a
// different endpoint than the tool intends. Every id is validated to its real
// shape before it gets anywhere near a path.

/** Devices, flows, zones, logic variables, alarms, moods, folders. Any
 *  8-4-4-4-12 hex id, without the RFC version/variant check, so ids minted by
 *  older firmware are not rejected. */
export const uuid = () =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");

/** Reverse-DNS app ids such as com.athom.homeyscript. */
export const appId = () =>
  z.string().regex(/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/i, "must be an app id such as com.athom.homeyscript");

/** HomeyScript ids: UUIDs or slugs. */
export const scriptId = () => z.string().regex(/^[A-Za-z0-9_-]+$/, "must be a script id (letters, digits, - and _)");

/** Insight log ids: homey:<type>:<owner id>[:<log id>], no slashes or "..". */
export const insightLogId = () =>
  z.string().regex(/^homey:[a-z]+(:[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)+$/, "must be an insight log id from list_insights");

export const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const HOMEYSCRIPT_BASE = "/api/app/com.athom.homeyscript";

/** Raw HomeyScript route with the id encoded as a single path segment. */
export function scriptPath(id?: string, action?: "run"): string {
  let p = `${HOMEYSCRIPT_BASE}/script`;
  if (id !== undefined) p += `/${encodeURIComponent(id)}`;
  if (action) p += `/${action}`;
  return p;
}
