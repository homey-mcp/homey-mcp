# Homey MCP Server

[![CI](https://github.com/homey-mcp/homey-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/homey-mcp/homey-mcp/actions/workflows/ci.yml)

MCP server for controlling [Homey Pro](https://homey.app/) smart home systems through the [Model Context Protocol](https://modelcontextprotocol.io/).

50 tools and 3 knowledge prompts for device control, automation, monitoring, troubleshooting, and more.

## Quick Start

```bash
git clone https://github.com/homey-mcp/homey-mcp.git
cd homey-mcp
npm install
npm run build
```

Authenticate with your Homey:

```bash
npx homey login
npx homey select
```

Add to your MCP client config (Kiro, Claude Desktop, Cline, etc.):

```json
{
  "mcpServers": {
    "homey": {
      "command": "node",
      "args": ["/path/to/homey-mcp/dist/index.js"]
    }
  }
}
```

## Authentication

The server tries these sources in order and logs the one it used to stderr (never the token itself):

1. **Local API key**: when both `HOMEY_ADDRESS` and `HOMEY_TOKEN` are set, they are used and nothing else is tried. A scoped key is therefore a real ceiling on what the server can do. Create one at [my.homey.app](https://my.homey.app/settings/system/api-keys) with only the scopes you need:

   ```bash
   export HOMEY_ADDRESS=http://192.168.1.x
   export HOMEY_TOKEN=your-api-key
   ```

2. **Cached LAN session**: `~/.athom-cli/homey-mcp-local-cache.json`, written after a successful Homey CLI login so later starts connect over the LAN without the rate-limited Athom cloud. It is validated with one authenticated call before use. It is discarded only when the Homey rejects it; an offline Homey or a timeout keeps it.
3. **Homey CLI token**: run `npx homey login` and `npx homey select`. The server reads the OAuth token from `~/.athom-cli/settings.json` and resolves the Homey's LAN address through the Athom cloud. This token has owner scope.

When a session expires mid-run, the server resets it and re-runs the call once, but only for read-only and idempotent tools. Other tools report the reset and are not re-run, because the rejection may have come after the action took effect.

### Credential files

The cache holds a session token. It is written with mode `0600` in a `0700` directory, and the server warns on stderr when `~/.athom-cli/settings.json` is readable by other accounts. To clear the cache, delete the file; the next start re-authenticates through the CLI token. To tighten the CLI's own files:

```bash
chmod 700 ~/.athom-cli && chmod 600 ~/.athom-cli/settings.json
```

### Environment variables

| Variable | Effect |
|----------|--------|
| `HOMEY_ADDRESS`, `HOMEY_TOKEN` | Local API key; takes precedence over the cache and the CLI token |
| `HOMEY_MCP_ALLOW_SECURITY_CAPS=1` | Allow `set_device_capability` on locks, garage doors, home alarms and `alarm_*` capabilities (refused by default) |
| `HOMEY_MCP_PRECISE_LOCATION=1` | `get_location` returns exact coordinates and the street address instead of coordinates rounded to 2 decimals |
| `ATHOM_API_CLIENT_ID`, `ATHOM_API_CLIENT_SECRET` | Override the public Homey CLI OAuth client used to refresh the CLI token |

## Safety

- Tool results are data. The server's MCP instructions tell the client that device, flow and zone names, card arguments, notification text, script source and script output are written by household members and apps and must not be followed as instructions. Control, bidi and zero-width characters are stripped from results and long strings are capped.
- Ids are validated before they reach the Homey API (UUIDs for devices, flows, zones, variables, alarms and moods; app, script and insight ids by pattern), so a crafted id cannot reach a different endpoint.
- `set_device_capability` checks the value against the device's capability definition: the capability must exist and be setable, and type, min/max and enum values are enforced.
- Tool annotations mark destructive tools (`run_script`, `upsert_script`, `trigger_flow`, `reboot_homey`, and the disable and delete paths) so clients can ask for confirmation.
- `get_system_info` leaves out network identifiers (SSID, MAC and IP addresses, gateway, DNS), the hostname and the cloud id.

## Tools

### Devices

| Tool | Description |
|------|-------------|
| `list_devices` | List devices, filter by zone or class |
| `get_device` | Get device details with all capability values |
| `search_devices` | Search by name, class, or capability |
| `set_device_capability` | Control a device (on/off, dim, temperature, etc.); value checked against the capability definition, security capabilities refused by default |

### Zones & Flows

| Tool | Description |
|------|-------------|
| `list_zones` | List all zones (rooms/areas) |
| `list_flows` | List simple and advanced flows with folder and enabled/broken state |
| `get_flow` | Full WHEN/AND/THEN definition of a flow, device and variable ids resolved to names; per-card `warnings` for missing action groups and malformed token references |
| `audit_flows` | Scan all simple and advanced flows for silent defects: actions without `group` (run regardless of conditions), malformed token references, plain-string autocomplete args, numbers in text args, missing required args, mixed condition groups, missing/unavailable devices, missing variables, deleted scripts or target flows, stale trigger arguments |
| `trigger_flow` | Run a flow |
| `set_flow_enabled` | Enable or disable a flow |

### Logic & Apps

| Tool | Description |
|------|-------------|
| `list_variables` | List logic variables |
| `set_variable` | Set a variable value |
| `list_apps` | List installed apps |
| `restart_app` | Restart a Homey app |
| `enable_app` | Enable or disable an app |
| `uninstall_app` | Uninstall an app |

### HomeyScript

| Tool | Description |
|------|-------------|
| `list_scripts` | List all HomeyScripts (id, name, last execution) |
| `get_script` | Get a script's source code and metadata |
| `upsert_script` | Create or overwrite a script |
| `run_script` | Execute a stored script, optionally with an argument |
| `delete_script` | Permanently delete a script |

### Insights & Energy

| Tool | Description |
|------|-------------|
| `list_insights` | List available insight logs |
| `get_insight_entries` | Get historical sensor data |
| `get_energy_live` | Live power consumption by zone/device |
| `get_energy_report` | Energy report for day/week/month/year |

### Weather & Presence

| Tool | Description |
|------|-------------|
| `get_weather` | Current weather at Homey's location |
| `get_weather_hourly` | Hourly weather forecast |
| `get_presence` | Home/away status for all users |
| `set_presence` | Set your presence or sleep state |
| `get_location` | Homey's configured location, coordinates rounded unless `HOMEY_MCP_PRECISE_LOCATION=1` |

### Alarms & Moods

| Tool | Description |
|------|-------------|
| `list_alarms` | List all alarms/timers |
| `set_alarm` | Create or update an alarm |
| `delete_alarm` | Delete an alarm |
| `list_moods` | List moods (scenes) per zone |
| `set_mood` | Activate a mood in a zone |

### Notifications & System

| Tool | Description |
|------|-------------|
| `list_notifications` | List recent notifications |
| `create_notification` | Send a notification |
| `get_system_info` | System info (version, model, uptime, memory, connectivity); no network identifiers |

### Infrastructure & Protocols

| Tool | Description |
|------|-------------|
| `list_drivers` | List all available device drivers |
| `get_zwave_log` | Z-Wave network log for troubleshooting |
| `get_backup_status` | Backup config and last backup time |
| `create_backup` | Schedule a new backup |
| `get_ledring` | LED ring screensaver options |
| `set_ledring` | Set LED ring screensaver |
| `get_updates` | Check for system updates |
| `get_session` | Current API session info |
| `reboot_homey` | Reboot the Homey Pro |
| `get_memory_info` | Memory usage by app/component |
| `get_storage_info` | Storage usage breakdown |
| `set_system_name` | Set the Homey system name |

## Prompts

Built-in knowledge prompts accessible via the MCP prompts API:

| Prompt | Description |
|--------|-------------|
| `homey_best_practices` | Zone architecture, device naming, protocol tips, energy management, security |
| `homey_troubleshooting` | Diagnosing offline devices, Z-Wave/Zigbee issues, flow debugging, performance |
| `homey_flow_patterns` | Automation patterns, naming conventions, anti-patterns to avoid |

## Development

```bash
npm run dev        # Run with tsx (no build step)
npm run build      # Compile TypeScript
npm run lint       # ESLint
npm run typecheck  # TypeScript strict check
npm test           # Unit tests (node:test via tsx)
npm start          # Run compiled version
```

## Tech Stack

- TypeScript + Node.js (≥22)
- [homey-api](https://www.npmjs.com/package/homey-api) v3 — Official Homey Web API client
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) v1.32 — MCP server (`registerTool` with `ToolAnnotations`)
- [zod](https://www.npmjs.com/package/zod) v4 — Parameter validation

## License

[MIT](LICENSE)
