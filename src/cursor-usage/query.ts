import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

export interface CursorUsageReport {
  fetchedAt: number;
  totalPercentUsed?: number;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  onDemandDollars?: number;
  billingCycleEnd?: number;
}

export type CursorUsageResult =
  | { ok: true; report: CursorUsageReport }
  | { ok: false; error: string; unavailable?: boolean };

export function isCursorModel(model: { provider: string } | undefined): boolean {
  return model?.provider === "cursor";
}

/** Resolve only the explicit Pi Cursor login, never desktop/CLI credentials.
 * pi-cursor returns a sentinel API key, not its OAuth token. Read the stored
 * access token after asking Pi to rotate expired credentials when necessary. */
async function resolveToken(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
  let credential = readStoredCredential("cursor");
  if (credential?.type !== "oauth") return undefined;
  if (credential.access && credential.expires > Date.now()) return credential.access;

  await Promise.race([
    ctx.modelRegistry.getProviderAuth("cursor"),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    }),
  ]);
  signal.throwIfAborted();
  credential = readStoredCredential("cursor");
  if (credential?.type === "oauth" && credential.access && credential.expires > Date.now()) {
    return credential.access;
  }
  throw new Error("Cursor login expired. Run /login for Cursor and try again.");
}

export async function queryCursorUsage(
  ctx: ExtensionContext,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<CursorUsageResult> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
  try {
    signal.throwIfAborted();
    const token = await resolveToken(ctx, signal);
    signal.throwIfAborted();
    if (!token) {
      return { ok: false, unavailable: true, error: "No Pi Cursor subscription login. Run /login for Cursor." };
    }
    const response = await fetch(USAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      // Do not echo response bodies: they may contain credentials or account data.
      const tip = response.status === 401 || response.status === 403 ? " Run /login for Cursor." : "";
      return { ok: false, error: `Cursor usage endpoint returned HTTP ${response.status}.${tip}` };
    }
    return { ok: true, report: normalizeCursorUsage(await response.json()) };
  } catch {
    // Auth provider exceptions can also contain secrets; keep errors local and generic.
    return {
      ok: false,
      error: timeout.signal.aborted ? "Cursor usage query timed out."
        : options.signal?.aborted ? "Cursor usage query cancelled."
        : "Unable to read Cursor usage. Check your connection and /login for Cursor.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Use Cursor's authoritative included percentage and the CLI's legacy spend
 * fallback. Never infer personal spend from a team's pooled usage. */
export function normalizeCursorUsage(payload: unknown, fetchedAt = Date.now()): CursorUsageReport {
  const data = object(payload);
  if (!data) throw new Error("Invalid Cursor usage response.");
  const plan = object(data.planUsage);
  const spend = object(data.spendLimitUsage);
  if (!plan && !spend && number(data.billingCycleEnd) === undefined) {
    throw new Error("Invalid Cursor usage response.");
  }
  let totalPercentUsed = number(plan?.totalPercentUsed);
  if (totalPercentUsed === undefined && plan) {
    const used = number(plan.includedSpend);
    const limit = number(plan.limit);
    if (used !== undefined && limit !== undefined && limit > 0) totalPercentUsed = number(used / limit * 100);
  }
  const reset = number(data.billingCycleEnd);
  // Cursor's protobuf declares Auto/API percentages optional, but individualUsed
  // is a non-optional int32 (zero when omitted within a present spend message).
  // Missing messages and malformed values are not confirmed zero usage.
  const individualUsed = spend
    ? spend.individualUsed === undefined ? 0 : number(spend.individualUsed)
    : undefined;
  return {
    fetchedAt,
    totalPercentUsed,
    autoPercentUsed: number(plan?.autoPercentUsed),
    apiPercentUsed: number(plan?.apiPercentUsed),
    onDemandDollars: individualUsed === undefined ? undefined : individualUsed / 100,
    billingCycleEnd: reset && !Number.isNaN(new Date(reset).getTime()) ? reset : undefined,
  };
}
