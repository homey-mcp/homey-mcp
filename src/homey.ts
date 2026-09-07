import fs from "fs";
import path from "path";

// homey-api is CJS, use require
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const AthomCloudAPI = require("homey-api/lib/AthomCloudAPI");
const { HomeyAPI } = require("homey-api");

// Athom cloud auth rate-limits aggressively. Once we've resolved the local
// Homey URL + session token via the cloud, persist them so subsequent process
// starts connect directly to the Homey over LAN without hitting the cloud.
const CACHE_PATH = path.join(process.env.HOME ?? "", ".athom-cli", "homey-mcp-local-cache.json");

// Public OAuth client credentials shipped with the official `homey` CLI
// (athom-cli). These are NOT secret — they are embedded verbatim in the
// published `homey` npm package's config.js and merely identify the CLI as
// a registered OAuth client. The secret is required for the cloud token
// *refresh* grant: without it, an expired CLI token cannot be renewed and
// the call fails with "Invalid or missing client_id", breaking cloud/off-LAN
// auth. Env overrides mirror the CLI's own ATHOM_API_CLIENT_* convention.
const ATHOM_CLI_CLIENT_ID =
  process.env.ATHOM_API_CLIENT_ID ?? "64691b4358336640a5ecee5c";
const ATHOM_CLI_CLIENT_SECRET =
  process.env.ATHOM_API_CLIENT_SECRET ?? "ed09f559ae12b1522d00431f0bf7c5755603c41e";

let cachedApi: any = null;
// Dedups concurrent auth attempts: a stdio client can pipeline several tool
// calls before the first resolves. Without this guard each would trigger its
// own (rate-limited) cloud re-auth — a thundering herd against Athom's API.
let inFlight: Promise<any> | null = null;

async function loadLocalCache(): Promise<{ address: string; token: string } | null> {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (data?.address && data?.token) return data;
  } catch { /* corrupt cache — ignore and fall through */ }
  return null;
}

async function saveLocalCache(address: string, token: string): Promise<void> {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ address, token }, null, 2), { mode: 0o600 });
  } catch { /* best-effort */ }
}

function discardLocalCache(): void {
  try { fs.unlinkSync(CACHE_PATH); } catch { /* already gone */ }
}

/** Drop the in-process memo and the on-disk LAN cache, forcing a full
 *  re-auth on the next getHomeyApi(). Both halves matter: deleting the file
 *  alone is inert while `cachedApi` still points at the poisoned instance. */
export function resetHomeyApi(): void {
  cachedApi = null;
  inFlight = null;
  discardLocalCache();
}

/** True for the "stale local session token" class of error. `createLocalAPI`
 *  never validates the token (its only startup call is an unauthenticated
 *  ping), and a local-API instance has no AthomCloudAPI to auto-refresh with,
 *  so an expired session surfaces as a raw 401 on the first real call. */
export function isAuthError(e: any): boolean {
  const code = e?.statusCode ?? e?.code;
  const msg = String(e?.message ?? e?.description ?? "");
  return code === 401 || /session not found|unauthor/i.test(msg);
}

export async function getHomeyApi(): Promise<any> {
  if (cachedApi) return cachedApi;
  // Coalesce concurrent callers onto a single authentication attempt.
  if (inFlight) return inFlight;
  inFlight = authenticate()
    .then((api) => { cachedApi = api; return api; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function authenticate(): Promise<any> {
  // Strategy 0: Persisted local creds from a previous successful connect.
  // The session token is minted from a short-lived cloud delegation and DOES
  // expire, so we must validate it with one cheap authenticated call before
  // trusting it — createLocalAPI itself would happily return a dead instance.
  const cache = await loadLocalCache();
  if (cache) {
    try {
      const api = await HomeyAPI.createLocalAPI({ address: cache.address, token: cache.token });
      await api.sessions.getSessionMe(); // authenticated probe — throws 401 if stale
      return api;
    } catch { /* stale/unreachable cache — delete and re-authenticate via cloud */
      discardLocalCache();
    }
  }

  // Strategy 1: Use Homey CLI stored OAuth token (~/.athom-cli/settings.json)
  const cliSettingsPath = path.join(
    process.env.HOME ?? "",
    ".athom-cli",
    "settings.json"
  );

  if (fs.existsSync(cliSettingsPath)) {
    const settings = JSON.parse(fs.readFileSync(cliSettingsPath, "utf8"));
    if (settings.homeyApi?.token) {
      const cloudApi = new AthomCloudAPI({
        clientId: ATHOM_CLI_CLIENT_ID,
        clientSecret: ATHOM_CLI_CLIENT_SECRET,
        token: new AthomCloudAPI.Token(settings.homeyApi.token),
      });

      const user = await cloudApi.getAuthenticatedUser();
      const homey = await user.getFirstHomey();
      const api = await homey.authenticate();
      // Persist resolved local creds so next start skips the cloud.
      const address = await api.baseUrl;
      const token = api.__token;
      if (address && token) await saveLocalCache(address, token);
      return api;
    }
  }

  // Strategy 2: Use HOMEY_ADDRESS + HOMEY_TOKEN env vars (local API key)
  const address = process.env.HOMEY_ADDRESS;
  const token = process.env.HOMEY_TOKEN;

  if (address && token) {
    return await HomeyAPI.createLocalAPI({ address, token });
  }

  throw new Error(
    "No Homey credentials found. Either:\n" +
      "  1. Run `homey login` and `homey select` (recommended)\n" +
      "  2. Set HOMEY_ADDRESS and HOMEY_TOKEN env vars (API key from https://my.homey.app/settings/system/api-keys)"
  );
}
