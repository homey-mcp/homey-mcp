/** Short-lived memo for collections that many calls in a row need (devices,
 *  zones, variables, folders). Concurrent callers share one load; a failed
 *  load is not kept. */
export class TtlCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    const entry = { at: this.now(), value };
    this.entries.set(key, entry);
    value.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
