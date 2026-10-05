import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCursorModel, queryCursorUsage, type CursorUsageReport, type CursorUsageResult } from "./query.js";

const CACHE_TTL_MS = 5 * 60_000;
const RETRY_BASE_MS = 60_000;
export type CursorUsageState = "idle" | "loading" | "loaded" | "error";

interface CursorUsageOutcome {
  result: CursorUsageResult;
  cached?: boolean;
  stale?: boolean;
}

/** Independent subscription cache with bounded retries and stale-response guards. */
export class CursorUsageManager {
  private cache?: { report: CursorUsageReport; createdAt: number };
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private pending?: Promise<CursorUsageOutcome | undefined>;
  private generation = 0;
  private disposed = false;
  private failures = 0;
  private retryAt = 0;
  private lastFailure?: Extract<CursorUsageResult, { ok: false }>;
  private onRender?: () => void;
  private _state: CursorUsageState = "idle";

  constructor(private query = queryCursorUsage) {}

  get state(): CursorUsageState { return this._state; }
  getReport(): CursorUsageReport | undefined { return this.cache?.report; }
  isCacheFresh(): boolean {
    return this._state === "loaded" && !!this.cache && Date.now() - this.cache.createdAt < CACHE_TTL_MS;
  }
  setRenderCallback(callback: (() => void) | undefined): void { this.onRender = callback; }

  setReport(report: CursorUsageReport, ctx?: ExtensionContext): void {
    if (this.disposed) return;
    this.invalidateRequest();
    this.cache = { report, createdAt: Date.now() };
    this.resetFailures();
    this._state = "loaded";
    if (ctx) this.schedule(ctx, CACHE_TTL_MS);
    this.onRender?.();
  }

  refresh(ctx: ExtensionContext, force = false, model = ctx.model): Promise<CursorUsageOutcome | undefined> {
    return this.request(ctx, force, model, 15_000);
  }

  /** Footer-updating commands share cancellation, generation, and retry policy
   * with background requests. Undefined means the request was invalidated. */
  queryStatus(
    ctx: ExtensionContext,
    options: { refresh: boolean; timeoutMs: number },
  ): Promise<CursorUsageOutcome | undefined> {
    if (this.pending && !options.refresh) return this.waitForPending(this.pending, options.timeoutMs);
    return this.request(ctx, options.refresh, ctx.model, options.timeoutMs);
  }

  /** A command's waiting deadline must not cancel or fail the shared query. */
  private async waitForPending(
    pending: Promise<CursorUsageOutcome | undefined>,
    timeoutMs: number,
  ): Promise<CursorUsageOutcome | undefined> {
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending,
        new Promise<CursorUsageOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ result: { ok: false, error: "Cursor usage query timed out." } }), timeoutMs);
        }),
      ]);
      return generation === this.generation ? outcome : undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private request(
    ctx: ExtensionContext,
    force: boolean,
    model: ExtensionContext["model"],
    timeoutMs: number,
  ): Promise<CursorUsageOutcome | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    if (this.pending && !force) return this.pending;
    const fresh = this.isCacheFresh();
    const backingOff = Date.now() < this.retryAt;
    if (!force && (fresh || backingOff)) {
      if (this.cache) {
        return Promise.resolve({ result: { ok: true, report: this.cache.report }, cached: true, stale: !fresh });
      }
      return Promise.resolve(this.lastFailure ? { result: this.lastFailure } : undefined);
    }
    this.invalidateRequest();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    if (!this.cache) this._state = "loading";
    this.onRender?.();
    const pending = this.runRefresh(ctx, model, generation, controller, timeoutMs);
    this.pending = pending;
    return pending;
  }

  private async runRefresh(
    ctx: ExtensionContext,
    model: ExtensionContext["model"],
    generation: number,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<CursorUsageOutcome | undefined> {
    try {
      const result = await this.query(ctx, { timeoutMs, signal: controller.signal });
      if (generation !== this.generation) return;
      if (result.ok) {
        this.cache = { report: result.report, createdAt: Date.now() };
        this.resetFailures();
        this._state = "loaded";
        this.schedule(ctx, CACHE_TTL_MS);
      } else {
        this.failed(ctx, isCursorModel(model), result);
      }
      return { result };
    } catch {
      if (generation !== this.generation) return;
      const result = { ok: false, error: "Unable to read Cursor usage. Check your connection and /login for Cursor." } as const;
      this.failed(ctx, isCursorModel(model), result);
      return { result };
    } finally {
      if (generation === this.generation) {
        this.pending = undefined;
        this.controller = undefined;
        this.onRender?.();
      }
    }
  }

  private failed(ctx: ExtensionContext, active: boolean, result: Extract<CursorUsageResult, { ok: false }>): void {
    this.failures++;
    this.lastFailure = result;
    // Retain a known report, but mark it stale instead of pretending it's fresh.
    this._state = this.cache || active ? "error" : "idle";
    if (!result.unavailable || this.cache || active) {
      const delay = Math.min(CACHE_TTL_MS, RETRY_BASE_MS * 2 ** Math.min(this.failures - 1, 3));
      this.retryAt = Date.now() + delay;
      this.schedule(ctx, delay);
    }
  }

  private resetFailures(): void {
    this.failures = 0;
    this.retryAt = 0;
    this.lastFailure = undefined;
  }

  clear(): void {
    this.invalidateRequest();
    this.cache = undefined;
    this.resetFailures();
    this._state = "idle";
    this.onRender?.();
  }

  dispose(): void {
    this.disposed = true;
    this.onRender = undefined;
    this.clear();
  }

  private invalidateRequest(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.pending = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ctx: ExtensionContext, delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh(ctx); }, delay);
    this.timer.unref?.();
  }
}
