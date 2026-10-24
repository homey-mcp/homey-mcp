// Pure auth helpers: no homey-api import, so they can be unit tested.

/** A Homey Web API rejection of the session itself: HTTP 401, or the exact
 *  "Session not found" message the local API returns for an expired token.
 *  Free-text matches such as "Unauthorized" are deliberately excluded: app
 *  drivers and HomeyScripts surface their own cloud errors with that word, and
 *  treating those as a Homey auth failure would reset a valid session and
 *  re-run the call. */
export function isAuthError(e: any): boolean {
  if (e?.statusCode === 401) return true;
  const msg = String(e?.message ?? e?.description ?? "").trim().toLowerCase();
  return msg === "session not found";
}

export function isNotFound(e: any): boolean {
  return e?.statusCode === 404;
}

/** `.catch(unlessAuth(null))`: swallow ordinary errors into a fallback value,
 *  but let auth errors reach the self-heal wrapper. */
export function unlessAuth<T>(fallback: T): (e: unknown) => T {
  return (e: unknown) => {
    if (isAuthError(e)) throw e;
    return fallback;
  };
}

/** A handler may be re-run after an auth reset only when running it twice
 *  cannot repeat a side effect. */
export function isRetrySafe(annotations: { readOnlyHint?: boolean; idempotentHint?: boolean } | undefined): boolean {
  return annotations?.readOnlyHint === true || annotations?.idempotentHint === true;
}

/** Self-heal wrapper. Resolves the instance first, runs the handler, and on a
 *  Homey auth rejection resets exactly that instance. A retry-safe handler is
 *  re-run once against a fresh session; any other handler is not re-run,
 *  because the rejection may have come after a side effect. A second failure
 *  propagates. */
export function withAuthRetry<A extends any[], R, T>(
  handler: (...args: A) => Promise<R>,
  opts: { getApi: () => Promise<T>; reset: (failed: T) => boolean; retrySafe: boolean },
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const api = await opts.getApi();
    try {
      return await handler(...args);
    } catch (e) {
      if (!isAuthError(e)) throw e;
      opts.reset(api);
      if (!opts.retrySafe) {
        throw new Error("The Homey session was rejected (401) and has been reset. This tool is not idempotent, so it was not re-run automatically: check whether it took effect before calling it again.");
      }
      return await handler(...args);
    }
  };
}

/** The Athom cloud relay is not a LAN address and must not be cached as one. */
export function isLanAddress(address: string): boolean {
  try {
    return !new URL(address).hostname.endsWith(".connect.athom.com");
  } catch {
    return false;
  }
}

export function isGroupOrWorldAccessible(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/** Memoises one authenticated API instance.
 *  - Concurrent callers share a single in-flight authentication.
 *  - reset(failed) acts only when `failed` is still the current instance, so N
 *    pipelined calls that all hit a 401 on the same stale instance cause one
 *    re-authentication, not N, and a late reset cannot discard a fresh one.
 *  - A generation counter stops a superseded authentication from overwriting
 *    the state set by a newer one. */
export class ApiHolder<T> {
  private cached: T | null = null;
  private inFlight: Promise<T> | null = null;
  private generation = 0;

  constructor(
    private readonly authenticate: () => Promise<T>,
    private readonly onReset: () => void,
  ) {}

  get(): Promise<T> {
    if (this.cached) return Promise.resolve(this.cached);
    if (this.inFlight) return this.inFlight;
    const gen = this.generation;
    const p: Promise<T> = this.authenticate()
      .then((api) => {
        if (gen === this.generation) this.cached = api;
        return api;
      })
      .finally(() => {
        if (this.inFlight === p) this.inFlight = null;
      });
    this.inFlight = p;
    return p;
  }

  /** Returns true when state was reset. Without an argument the reset is
   *  unconditional. */
  reset(failed?: T): boolean {
    if (failed !== undefined && this.cached !== failed) return false;
    this.cached = null;
    this.inFlight = null;
    this.generation++;
    this.onReset();
    return true;
  }
}
