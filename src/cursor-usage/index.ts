export { CursorUsageManager, type CursorUsageState } from "./manager.js";
export { isCursorModel, queryCursorUsage, normalizeCursorUsage, type CursorUsageReport } from "./query.js";

import type { CursorUsageReport } from "./query.js";

export function cursorRemaining(percentUsed: number): number {
  return 100 - Math.min(100, Math.max(0, percentUsed));
}

/** Cursor CLI shows the billing-cycle date in UTC (the endpoint uses milliseconds). */
export function formatCursorReset(epochMs: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(epochMs));
}

export function formatCursorUsageReport(
  report: CursorUsageReport,
  options: { cached?: boolean; stale?: boolean } = {},
): string {
  const percent = (value: number | undefined) => value === undefined ? "unavailable" : `${value.toFixed(0)}% used`;
  const lines = [
    `Cursor Subscription Usage${options.stale ? " (cached, stale)" : options.cached ? " (cached)" : ""}`,
    "",
    `Included: ${percent(report.totalPercentUsed)}${report.totalPercentUsed === undefined ? "" : ` (${cursorRemaining(report.totalPercentUsed).toFixed(0)}% left)`}`,
    `Auto: ${percent(report.autoPercentUsed)}`,
    `API: ${percent(report.apiPercentUsed)}`,
    `On-Demand: ${report.onDemandDollars === undefined ? "unavailable" : `$${report.onDemandDollars.toFixed(2)}`}`,
  ];
  if (report.billingCycleEnd) lines.push(`Resets ${formatCursorReset(report.billingCycleEnd)}`);
  if (report.totalPercentUsed === undefined) lines.push("Included usage percentages are not available for this plan.");
  lines.push("", "https://cursor.com/dashboard?tab=usage");
  return lines.join("\n");
}
