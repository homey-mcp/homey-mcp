// Validation for set_device_capability, against the device's own capability
// definitions (capabilitiesObj: type, setable, min, max, values).

const SECURITY_CAPABILITIES = new Set(["locked", "garagedoor_closed", "homealarm_state"]);
const SECURITY_CLASSES = new Set(["lock", "garagedoor", "homealarm"]);

/** Locks, garage doors, home alarms and alarm_* capabilities change the
 *  physical security of the home. Sub-capabilities (`locked.front`) count as
 *  their base capability. */
export function isSecurityCapability(capabilityId: string, deviceClass: string | undefined): boolean {
  const base = capabilityId.split(".")[0];
  return SECURITY_CAPABILITIES.has(base) || base.startsWith("alarm_") || SECURITY_CLASSES.has(String(deviceClass ?? ""));
}

/** Returns an error message, or null when the write is allowed. */
export function validateCapabilityWrite(
  device: { class?: string; capabilitiesObj?: Record<string, any> },
  capabilityId: string,
  value: unknown,
  opts: { allowSecurityCaps: boolean },
): string | null {
  const caps = device.capabilitiesObj ?? {};
  const cap = caps[capabilityId];
  if (!cap) return `Device has no capability "${capabilityId}". Available: ${Object.keys(caps).join(", ") || "none"}`;
  if (cap.setable === false) return `Capability "${capabilityId}" is not setable (read-only sensor or state)`;
  if (isSecurityCapability(capabilityId, device.class) && !opts.allowSecurityCaps) {
    return `Refusing to set "${capabilityId}" on a ${device.class ?? "device"}: locks, garage doors and alarms are blocked. Start the server with HOMEY_MCP_ALLOW_SECURITY_CAPS=1 to allow it.`;
  }
  switch (cap.type) {
    case "boolean":
      if (typeof value !== "boolean") return `"${capabilityId}" takes a boolean`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `"${capabilityId}" takes a number`;
      if (typeof cap.min === "number" && value < cap.min) return `${value} is below the minimum ${cap.min} for "${capabilityId}"`;
      if (typeof cap.max === "number" && value > cap.max) return `${value} is above the maximum ${cap.max} for "${capabilityId}"`;
      break;
    case "enum": {
      const ids = (cap.values ?? []).map((v: any) => v?.id);
      if (typeof value !== "string" || (ids.length && !ids.includes(value))) return `"${capabilityId}" takes one of: ${ids.join(", ")}`;
      break;
    }
    case "string":
      if (typeof value !== "string") return `"${capabilityId}" takes a string`;
      break;
  }
  return null;
}
