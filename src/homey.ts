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

let cachedApi: any = null;

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

export async function getHomeyApi(): Promise<any> {
  if (cachedApi) return cachedApi;

  // Strategy 0: Persisted local creds from a previous successful connect.
  const cache = await loadLocalCache();
  if (cache) {
    try {
      cachedApi = await HomeyAPI.createLocalAPI({ address: cache.address, token: cache.token });
      return cachedApi;
    } catch { /* stale cache — delete and re-authenticate via cloud */
      try { fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
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
        clientId: "64691b4358336640a5ecee5c", // Homey CLI client ID
        clientSecret: "",
        token: new AthomCloudAPI.Token(settings.homeyApi.token),
      });

      const user = await cloudApi.getAuthenticatedUser();
      const homey = await user.getFirstHomey();
      cachedApi = await homey.authenticate();
      // Persist resolved local creds so next start skips the cloud.
      const address = await cachedApi.baseUrl;
      const token = cachedApi.__token;
      if (address && token) await saveLocalCache(address, token);
      return cachedApi;
    }
  }

  // Strategy 2: Use HOMEY_ADDRESS + HOMEY_TOKEN env vars (local API key)
  const address = process.env.HOMEY_ADDRESS;
  const token = process.env.HOMEY_TOKEN;

  if (address && token) {
    cachedApi = await HomeyAPI.createLocalAPI({ address, token });
    return cachedApi;
  }

  throw new Error(
    "No Homey credentials found. Either:\n" +
      "  1. Run `homey login` and `homey select` (recommended)\n" +
      "  2. Set HOMEY_ADDRESS and HOMEY_TOKEN env vars (API key from https://my.homey.app/settings/system/api-keys)"
  );
}
