// MCP tool annotations. Clients use these to decide how much confirmation a
// call needs, and the self-heal wrapper re-runs a call after an auth reset
// only when readOnlyHint or idempotentHint is true.

export interface Annotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint?: boolean;
}

export const READ: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
/** Sets state to a given value; repeating the call changes nothing more. */
export const WRITE: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
/** Additive, but each call adds something (a notification, an alarm, a backup). */
export const WRITE_ONCE: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
/** Disables, deletes or overwrites; repeating it reaches the same end state. */
export const DESTRUCTIVE_IDEMPOTENT: Annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
/** Runs arbitrary actions or code, or overwrites; every call may act again. */
export const DESTRUCTIVE: Annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

/** Annotations for every tool that changes something. Tools not listed are
 *  read-only. `set_device_capability` becomes destructive when security
 *  capabilities (locks, garage doors, alarms) are allowed. */
export function writeAnnotations(allowSecurityCaps: boolean): Record<string, Annotations> {
  return {
    set_device_capability: allowSecurityCaps ? DESTRUCTIVE_IDEMPOTENT : WRITE,
    trigger_flow: DESTRUCTIVE,
    set_flow_enabled: DESTRUCTIVE_IDEMPOTENT,
    set_variable: WRITE,
    restart_app: WRITE_ONCE,
    enable_app: DESTRUCTIVE_IDEMPOTENT,
    uninstall_app: DESTRUCTIVE_IDEMPOTENT,
    upsert_script: DESTRUCTIVE,
    run_script: DESTRUCTIVE,
    delete_script: DESTRUCTIVE_IDEMPOTENT,
    set_presence: WRITE,
    create_notification: WRITE_ONCE,
    set_alarm: WRITE_ONCE,
    delete_alarm: DESTRUCTIVE_IDEMPOTENT,
    set_mood: WRITE,
    create_backup: WRITE_ONCE,
    set_ledring: WRITE,
    reboot_homey: DESTRUCTIVE,
    set_system_name: WRITE,
  };
}
