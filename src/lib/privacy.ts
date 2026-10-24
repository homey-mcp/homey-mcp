// What leaves the home through tool results: network identifiers, the cloud
// id and the exact location stay out unless asked for.

const SYSTEM_INFO_KEYS = [
  "homeyVersion", "homeyModelId", "homeyModelName", "homeyPlatform", "homeyPlatformVersion", "nodeVersion",
  "language", "timezone", "date", "dateDst", "uptime", "bootDate", "rebootReason",
  "totalmem", "freemem", "loadavg", "platform", "devmode",
  "videoCoreTemperature", "videoCoreUndervoltageOccured", "videoCoreThrottleOccured",
  "wifiConnected", "wifiStrength", "wifiFrequency", "ethernetConnected",
] as const;

/** Allow-list: no SSID, MAC, IP, gateway, DNS, subnet, hostname or cloud id. */
export function pickSystemInfo(info: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SYSTEM_INFO_KEYS) if (k in info) out[k] = info[k];
  return out;
}

const round2 = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);

/** Coordinates rounded to 2 decimals (about 1 km) and the street address
 *  withheld, unless precise output is allowed. */
export function coarseLocation(location: any, address: any, precise: boolean): { address: unknown; location: unknown; precise: boolean } {
  const loc = location?.value ?? null;
  const addr = address?.value ?? null;
  if (precise) return { address: addr, location: loc, precise };
  return {
    address: addr ? "withheld; start the server with HOMEY_MCP_PRECISE_LOCATION=1 to include it" : null,
    location: loc ? { ...loc, latitude: round2(loc.latitude), longitude: round2(loc.longitude) } : null,
    precise,
  };
}
