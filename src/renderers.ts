import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { ansi, readableTextOn } from "./ansi.js";
import { chip, plain, renderChip, renderChips, renderSegmentedChip } from "./chips.js";
import { isOpenAICodexModel } from "./codex-usage/index.js";
import { cursorRemaining, isCursorModel } from "./cursor-usage/index.js";
import {
  formatCodexChipData,
  formatCost,
  formatCount,
  formatFinishTime,
  formatResetCountdown,
  formatThinking,
  formatWorkingPath,
  modelName,
  shorten,
  smartPathTruncate,
} from "./format.js";
import { getGitSnapshot } from "./git.js";
import { COLOR, codexPercentColor, pullRequestColor, thinkingColor } from "./theme.js";
import type { Chip, GitStatusPart, PullRequestInfo, RuntimeState } from "./types.js";

// ── Line Renderers ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Render the **primary** footer line (line 1 of 3).
 *
 * Left side:  working-directory path chip.
 * Right side: provider/model | THINK chips (priority-trimmed to fit the width).
 *
 * The right-side chips are passed to `fitLeftRight` which progressively drops
 * lower-priority chips (priority 3 first, then 2) until both sides fit.
 */
export function renderPrimaryLine(
  width: number,
  ctx: ExtensionContext,
  runtime: RuntimeState,
): string {
  const provider = ctx.model?.provider ?? "PROVIDER";
  const providerLabel = provider === "openai-codex" ? "OpenAI" : provider;
  const right: Chip[] = [
    // Priority 1: always shown – provider + model is the most important identifier.
    chip(providerLabel, modelName(ctx), COLOR.model, 1, {
      valueBg: COLOR.panelLift,
      boldValue: true,
    }),
    // Priority 2: thinking level – useful but can be dropped on narrow terminals.
    chip(
      "THINK",
      formatThinking(runtime.thinkingLevel),
      thinkingColor(runtime.thinkingLevel),
      2,
      {
        valueBg: COLOR.panelLift,
      },
    ),
  ];

  const path = formatWorkingPath(ctx.cwd);
  return fitLeftRight(width, right, (available) =>
    renderFittedPathChip(path, available),
  );
}

/** Fewest branch-name columns a git-line layout may leave before a more compact one is tried. */
const BRANCH_MIN_WIDTH = 12;

/**
 * Render the **git** footer line (line 2 of 3): linked-worktree chip, branch
 * chip with status symbols, and the branch's pull request chip, left-aligned.
 * Blank outside a git repository.
 *
 * Tries progressively more compact layouts until the branch name keeps at
 * least `BRANCH_MIN_WIDTH` columns (or its full width, if shorter):
 *  1. Worktree (24) + status + PR
 *  2. Worktree (12) + status + PR
 *  3. Status + PR
 *  4. PR only
 *  5. Branch only
 *
 * If no layout fits, the branch name alone is shortened to the room that is left.
 */
export function renderGitLine(
  width: number,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  runtime: RuntimeState,
): string {
  // The footer-data provider may have a branch name from the session that is
  // more up-to-date than what `git status` returns (e.g. immediately after a
  // branch switch, before the git cache has expired).
  const footerBranch = footerData.getGitBranch() ?? undefined;
  const git = getGitSnapshot(ctx.cwd, footerBranch);
  const branch = git.branch ?? footerBranch;
  if (!branch) return "";

  // Pi reports a detached HEAD as the branch "detached", which has no pull request.
  const pr = branch === "detached" ? undefined : runtime.pullRequests.get(ctx.cwd, branch);
  const minBranchWidth = Math.min(visibleWidth(branch), BRANCH_MIN_WIDTH);

  for (const layout of [
    { worktreeWidth: 24, includeStatus: true, includePr: true },
    { worktreeWidth: 12, includeStatus: true, includePr: true },
    { worktreeWidth: 0, includeStatus: true, includePr: true },
    { worktreeWidth: 0, includeStatus: false, includePr: true },
    { worktreeWidth: 0, includeStatus: false, includePr: false },
  ]) {
    const worktreeChip =
      layout.worktreeWidth > 0 && git.worktreeName
        ? renderWorktreeChip(git.worktreeName, layout.worktreeWidth)
        : "";
    const prChip = layout.includePr && pr ? renderPullRequestChip(pr) : "";
    const statusParts = layout.includeStatus ? git.statusParts : undefined;

    // Each companion chip costs its own width plus one separating space.
    const companionsWidth = [worktreeChip, prChip]
      .filter(Boolean)
      .reduce((sum, part) => sum + visibleWidth(part) + 1, 0);
    const chromeWidth = visibleWidth(renderBranchChip("", statusParts));
    const branchWidth = width - companionsWidth - chromeWidth;
    if (branchWidth < minBranchWidth) continue;

    const branchChip = renderBranchChip(shorten(branch, branchWidth), statusParts);
    return [worktreeChip, branchChip, prChip].filter(Boolean).join(" ");
  }

  // Last resort: branch chip alone, shortened like the layouts above so it keeps
  // its ellipsis and closing arrow; hard-truncate only when not even that fits.
  const room = Math.max(1, width - visibleWidth(renderBranchChip("")));
  return truncateToWidth(renderBranchChip(shorten(branch, room)), width, "");
}

/**
 * Render the **usage** footer line (line 3 of 3).
 *
 * Left side:  subscription usage chips (active provider first).
 * Right side: finish time | CTX | ↑ uncached input | ↓ output | R cache read |
 * W cache write | $ cost. Cache counters are shown only when nonzero.
 * Time and tokens are plain text; context and cost keep their chip styling.
 *
 * Time and cost are priority 2 (dropped first) so context and token counts
 * stay visible on narrow terminals.
 */
export function renderUsageLine(
  width: number,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  runtime: RuntimeState,
): string {
  const totals = runtime.tokenTotals;
  const context = runtime.context;
  const right: Chip[] = [
    plain("", formatFinishTime(runtime.lastTurnFinishedAt), COLOR.finishTime, 2),
    chip("CTX", context.label, context.color, 1, {
      valueBg: COLOR.panelLift,
      boldValue: true,
    }),
    plain("↑", formatCount(totals.input), COLOR.token, 1),
    plain("↓", formatCount(totals.output), COLOR.token, 1),
    ...(totals.cacheRead > 0
      ? [plain("R", formatCount(totals.cacheRead), COLOR.token, 1)]
      : []),
    ...(totals.cacheWrite > 0
      ? [plain("W", formatCount(totals.cacheWrite), COLOR.token, 1)]
      : []),
    chip("$", formatCost(totals.cost), COLOR.cost, 2, { boldValue: true }),
  ];

  return fitLeftRight(width, right, (available) =>
    renderSubscriptionStatus(available, runtime, ctx),
  );
}

/**
 * Render a full-width separator line.
 *
 * @param separate  Character(s) to repeat.  Defaults to `"─"` (thin box rule).
 *                  Pass `" "` for the blank spacer between the two data rows.
 */
export function renderSeparatorLine(width: number, separate?: string): string {
  return ansi(separate ?? "─".repeat(Math.max(0, width)), {
    fg: COLOR.separator,
  });
}

// ── Layout ───────────────────────────────────────────────────────────

/**
 * Lay out a left-side content and a right-side chip row within `width` columns.
 *
 * The algorithm iterates from the highest priority (3) down to 1, progressively
 * dropping lower-priority right chips until the combined row fits.  A single
 * space gap is added between left and right when the right side is non-empty.
 *
 * If no combination fits (rare – only on extremely narrow terminals), the left
 * content alone is rendered, hard-truncated to `width`.
 */
function fitLeftRight(
  width: number,
  rightChips: Chip[],
  renderLeft: (available: number) => string,
): string {
  for (let priority = 3; priority >= 1; priority -= 1) {
    // Include only chips whose priority is at or below the current threshold.
    const right = renderChips(
      rightChips.filter((item) => item.priority <= priority),
    );
    const rightWidth = visibleWidth(right);
    const gap = rightWidth > 0 ? 1 : 0;
    const availableLeft = Math.max(0, width - rightWidth - gap);
    const left = renderLeft(availableLeft);
    const leftWidth = visibleWidth(left);

    if (leftWidth + rightWidth + gap <= width) {
      // Pad the gap between left and right to fill the row completely.
      const padding = " ".repeat(Math.max(gap, width - leftWidth - rightWidth));
      return truncateToWidth(`${left}${padding}${right}`, width, "");
    }
  }

  // All priority levels exhausted – render left side only.
  return truncateToWidth(renderLeft(width), width, "");
}

// ── Path Chips ────────────────────────────────────────────—————————————————————————————————————————————───────────

/**
 * Render a path chip with the standard styling (sky-blue accent, folder icon,
 * bold value, and lifted panel background for the value area).
 */
function renderPathChip(value: string): string {
  return renderChip(
    chip("", value, COLOR.path, 1, {
      labelFg: COLOR.black,
      valueBg: COLOR.panelLift,
      boldValue: true,
    }),
  );
}

/**
 * Render a path chip that fits within `maxWidth` visible columns.
 *
 * If the full path chip fits, return it directly.  Otherwise compute how many
 * columns remain for the path text itself (subtracting the fixed chip chrome
 * width), truncate the path with `smartPathTruncate` to preserve meaningful
 * context, and hard-truncate the final chip to guard against edge cases.
 */
function renderFittedPathChip(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  const fullPathChip = renderPathChip(path);
  if (visibleWidth(fullPathChip) <= maxWidth) return fullPathChip;

  // Measure the overhead of the chip chrome (separators, padding, empty label).
  const emptyPathChipWidth = visibleWidth(renderPathChip(""));
  const pathWidth = Math.max(3, maxWidth - emptyPathChipWidth);
  return truncateToWidth(
    renderPathChip(smartPathTruncate(path, pathWidth)),
    maxWidth,
    "",
  );
}

// ── Git Chips ────────────────────────────────────────────—————————————————————————————————————————————───────────

/**
 * Render a branch chip as a segmented chip: bold branch name followed by
 * coloured status-indicator segments (e.g. `~2 +1 ✘3`).
 *
 * When `statusParts` is omitted (compact layout), only the branch name is shown.
 * Callers shorten `branchText` to fit beforehand.
 */
function renderBranchChip(
  branchText: string,
  statusParts?: GitStatusPart[],
): string {
  const segments = [
    { text: branchText, fg: COLOR.git, bold: true },
    ...(statusParts ?? []).map((part) => ({
      text: `${part.symbol}${part.count}`,
      fg: part.color,
      bold: true,
    })),
  ];

  return renderSegmentedChip("", segments, COLOR.git, {
    labelFg: COLOR.black,
    valueBg: COLOR.panelLift,
  });
}

/**
 * Render the linked-worktree chip with a folder icon (󰙅) and a truncated
 * worktree name.  Dropped before the branch on narrow terminals.
 */
function renderWorktreeChip(worktreeName: string, maxWidth: number): string {
  return renderChip(
    chip("󰙅", shorten(worktreeName, maxWidth), COLOR.worktree, 2, {
      labelFg: COLOR.black,
    }),
  );
}

/**
 * Render the pull request chip: a PR icon () on the GitHub state colour
 * (open, draft, merged, closed) followed by the PR number.
 */
function renderPullRequestChip(pr: PullRequestInfo): string {
  return renderChip(
    chip("", `#${pr.number}`, pullRequestColor(pr.state), 1, {
      labelFg: COLOR.black,
      valueBg: COLOR.panelLift,
      boldValue: true,
    }),
  );
}

// ── Codex Chip ─────────────────────────────────────────────—————————————————————————————————————————————──────────

/**
 * Render the OpenAI Codex usage chip for the usage line's left side.
 *
 * Returns an empty string when:
 *  - `maxWidth` is zero or negative.
 *  - No report has been fetched yet AND the manager is idle AND the active
 *    model is a Codex model (the chip will appear once the first fetch lands).
 *
 * Fits the chip within `maxWidth` by first trying the full segmented chip
 * (with individual coloured segments), then falling back to a plain chip with
 * the concatenated text truncated to the available space.
 */
function renderSubscriptionStatus(maxWidth: number, runtime: RuntimeState, ctx: ExtensionContext): string {
  const cursorActive = isCursorModel(ctx.model);
  const cursor = renderCursorStatus(maxWidth, runtime, ctx);
  // Avoid an empty OpenAI placeholder taking space from the active Cursor meter.
  const codex = cursorActive && !runtime.codexUsage.getReport()
    ? "" : renderCodexStatus(maxWidth, runtime, ctx);
  if (!cursor) return codex;
  if (!codex) return cursor;
  if (visibleWidth(cursor) + visibleWidth(codex) + 1 <= maxWidth) {
    return cursorActive ? `${cursor} ${codex}` : `${codex} ${cursor}`;
  }
  // Prefer the active subscription on narrow terminals; show both when practical.
  const first = cursorActive ? renderCursorStatus : renderCodexStatus;
  const second = cursorActive ? renderCodexStatus : renderCursorStatus;
  if (maxWidth < 60) return first(maxWidth, runtime, ctx);
  const budget = Math.floor((maxWidth - 1) / 2);
  const left = first(budget, runtime, ctx);
  return `${left} ${second(maxWidth - visibleWidth(left) - 1, runtime, ctx)}`;
}

function renderCursorStatus(maxWidth: number, runtime: RuntimeState, ctx: ExtensionContext): string {
  if (maxWidth <= 0) return "";
  const manager = runtime.cursorUsage;
  const report = manager.getReport();
  const active = isCursorModel(ctx.model);
  if (!report && (!active || manager.state === "idle")) return "";
  const remaining = report?.totalPercentUsed === undefined ? undefined : cursorRemaining(report.totalPercentUsed);
  const text = report ? remaining === undefined ? "usage unavailable" : `${remaining.toFixed(0)}%`
    : manager.state === "loading" ? "checking…" : "unavailable";
  const stale = report && manager.state === "error" ? " · stale" : "";
  const reset = report?.billingCycleEnd ? formatResetCountdown({
    usedPercent: report.totalPercentUsed ?? 0,
    resetsAt: report.billingCycleEnd / 1000,
    windowMinutes: 30 * 24 * 60,
  }, "mo") : "";
  const accent = !active ? COLOR.openAiInactive : manager.state === "error" ? COLOR.contextFull : COLOR.model;
  const options = { labelFg: readableTextOn(accent), valueBg: COLOR.panelLift };
  const full = renderSegmentedChip("Cursor", [
    { text, fg: remaining === undefined ? COLOR.soft : codexPercentColor(remaining), bold: true },
    { text: `${reset}${stale}`.trimStart(), fg: stale ? COLOR.contextFull : COLOR.soft },
  ], accent, options);
  if (visibleWidth(full) <= maxWidth) return full;
  const compact = renderChip(chip("Cursor", `${text}${reset ? ` ${reset}` : ""}${stale}`, accent, 1, {
    ...options,
    valueFg: remaining === undefined ? COLOR.soft : codexPercentColor(remaining),
  }));
  return truncateToWidth(compact, maxWidth, "");
}

function renderCodexStatus(
  maxWidth: number,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): string {
  if (maxWidth <= 0) return "";

  const manager = runtime.codexUsage;
  const report = manager.getReport();

  // Suppress the chip entirely when there is no data and the manager hasn't
  // started fetching yet (avoids a permanent "usage —" placeholder for
  // sessions that will never use Codex).
  if (!report && manager.state === "idle" && isOpenAICodexModel(ctx.model))
    return "";

  const data = formatCodexChipData(report, manager.state, ctx.model);
  const accent = data.accent;
  const labelFg = readableTextOn(accent);

  // Try the full segmented chip first.
  const full = renderSegmentedChip("OpenAI", data.segments, accent, {
    labelFg,
    valueBg: COLOR.panelLift,
  });
  if (visibleWidth(full) <= maxWidth) return full;

  // Fallback: plain chip with the concatenated text, truncated to fit.
  const emptyWidth = visibleWidth(
    renderChip(
      chip("OpenAI", "", accent, 1, { labelFg, valueBg: COLOR.panelLift }),
    ),
  );
  const valueWidth = Math.max(1, maxWidth - emptyWidth);
  return truncateToWidth(
    renderChip(
      chip("OpenAI", truncateToWidth(data.text, valueWidth, "…"), accent, 1, {
        labelFg,
        valueBg: COLOR.panelLift,
        // Only bold the value when the data is freshly loaded (not an error/loading placeholder).
        boldValue: manager.state === "loaded",
      }),
    ),
    maxWidth,
    "",
  );
}
