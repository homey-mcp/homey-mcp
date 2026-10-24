import fs from "fs";
import path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiHolder, isAuthError, isGroupOrWorldAccessible, isLanAddress } from "./lib/auth.js";
import { readCacheFile, writeCacheFile } from "./lib/cache-file.js";

export { isAuthError } from "./lib/auth.js";

// homey-api is CJS, use require
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const AthomCloudAPI = require("homey-api/lib/AthomCloudAPI");
const { HomeyAPI } = require("homey-api");

const CLI_DIR = path.join(process.env.HOME ?? "", ".athom-cli");
const CLI_SETTINGS_PATH = path.join(CLI_DIR, "settings.json");
// Athom cloud auth rate-limits aggressively. Once we've resolved the local
// Homey URL + session token via the cloud, persist them so subsequent process
// starts connect directly to the Homey over LAN without hitting the cloud.
// The file holds a session token: it is kept owner-only (0600, dir 0700).
export const CACHE_PATH = path.join(CLI_DIR, "homey-mcp-local-cache.json");

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

type AuthSource = "env" | "cache" | "cli";
let currentSource: AuthSource | null = null;

function log(msg: string): void {
  console.error(`homey-mcp: ${msg}`);
}

function discardLocalCache(): void {
  try { fs.unlinkSync(CACHE_PATH); } catch { /* already gone */ }
}

function saveLocalCache(address: string, token: string): void {
  if (!isLanAddress(address)) return; // never persist the cloud relay as the LAN address
  try { writeCacheFile(CACHE_PATH, { address, token }); } catch (e: any) { log(`could not write LAN session cache: ${e?.message ?? e}`); }
}

// Concurrent callers share one authentication; a reset only applies to the
// instance that actually failed (see ApiHolder).
const holder = new ApiHolder<any>(authenticate, () => {
  // An env API key never touches the cache, so a reset there keeps it.
  if (currentSource !== "env") discardLocalCache();
});

// The instance a tool call resolved at its start. Inside withPinnedApi,
// getHomeyApi() returns it, so a mid-call reset by another call cannot switch
// the handler to a different instance than the one the self-heal wrapper resets.
const pinned = new AsyncLocalStorage<any>();

export function getHomeyApi(): Promise<any> {
  const api = pinned.getStore();
  return api ? Promise.resolve(api) : holder.get();
}

export function withPinnedApi<R>(api: any, fn: () => Promise<R>): Promise<R> {
  return pinned.run(api, fn);
}

/** Drop the memoised instance (and the on-disk LAN cache) so the next
 *  getHomeyApi() re-authenticates. Pass the instance that failed: if another
 *  caller already replaced it, nothing happens. Returns true when reset. */
export function resetHomeyApi(failed?: any): boolean {
  return holder.reset(failed);
}

async function authenticate(): Promise<any> {
  // Strategy 1: an explicit local API key. It wins over everything else so a
  // scoped key is a real ceiling and is never silently replaced by the
  // owner-scope CLI token.
  const envAddress = process.env.HOMEY_ADDRESS;
  const envToken = process.env.HOMEY_TOKEN;
  if (envAddress && envToken) {
    currentSource = "env";
    log("auth source: HOMEY_ADDRESS + HOMEY_TOKEN (local API key)");
    return await HomeyAPI.createLocalAPI({ address: envAddress, token: envToken });
  }
  if (envAddress || envToken) log("only one of HOMEY_ADDRESS / HOMEY_TOKEN is set; ignoring both");

  // Strategy 2: persisted LAN session from a previous cloud-resolved connect.
  // The session token is minted from a short-lived cloud delegation and DOES
  // expire, so validate it with one cheap authenticated call before trusting
  // it: createLocalAPI itself would happily return a dead instance. Only an
  // auth rejection invalidates the cache; an offline Homey or a timeout keeps
  // it for the next start.
  const cache = readCacheFile(CACHE_PATH);
  if (cache) {
    try {
      const api = await HomeyAPI.createLocalAPI({ address: cache.address, token: cache.token });
      await api.sessions.getSessionMe(); // authenticated probe
      currentSource = "cache";
      log(`auth source: cached LAN session (${CACHE_PATH})`);
      return api;
    } catch (e: any) {
      if (isAuthError(e)) {
        log("cached LAN session was rejected; discarding it");
        discardLocalCache();
      } else {
        log(`cached LAN session not usable right now (${e?.message ?? e}); trying the Homey CLI token, cache kept`);
      }
    }
  }

  // Strategy 3: Homey CLI stored OAuth token (~/.athom-cli/settings.json)
  if (fs.existsSync(CLI_SETTINGS_PATH)) {
    try {
      if (isGroupOrWorldAccessible(fs.statSync(CLI_SETTINGS_PATH).mode)) {
        log(`warning: ${CLI_SETTINGS_PATH} is readable by other accounts; it holds an owner-scope token. Run: chmod 600 ${CLI_SETTINGS_PATH}`);
      }
    } catch { /* stat is advisory only */ }
    const settings = JSON.parse(fs.readFileSync(CLI_SETTINGS_PATH, "utf8"));
    if (settings.homeyApi?.token) {
      const cloudApi = new AthomCloudAPI({
        clientId: ATHOM_CLI_CLIENT_ID,
        clientSecret: ATHOM_CLI_CLIENT_SECRET,
        token: new AthomCloudAPI.Token(settings.homeyApi.token),
      });

      const user = await cloudApi.getAuthenticatedUser();
      const homey = await user.getFirstHomey();
      const api = await homey.authenticate();
      currentSource = "cli";
      log("auth source: Homey CLI token (~/.athom-cli/settings.json) via Athom cloud");
      // Persist resolved local creds so next start skips the cloud.
      const address = await api.baseUrl;
      const token = api.__token;
      if (address && token) saveLocalCache(address, token);
      return api;
    }
  }

  throw new Error(
    "No Homey credentials found. Either:\n" +
      "  1. Set HOMEY_ADDRESS and HOMEY_TOKEN env vars (API key from https://my.homey.app/settings/system/api-keys)\n" +
      "  2. Run `homey login` and `homey select`"
  );
}
