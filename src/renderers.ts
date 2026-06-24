import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { ansi, readableTextOn } from "./ansi.js";
import { chip, renderChip, renderChips, renderSegmentedChip } from "./chips.js";
import { isOpenAICodexModel } from "./codex-usage/index.js";
import {
  formatCodexChipData,
  formatCost,
  formatCount,
  formatThinking,
  formatWorkingPath,
  modelName,
  shorten,
  smartPathTruncate,
} from "./format.js";
import { getGitSnapshot } from "./git.js";
import { COLOR, thinkingColor } from "./theme.js";
import type { Chip, GitStatusPart, RuntimeState } from "./types.js";

// ── Line Renderers ───────────────────────────────────────────────────

/**
 * Render the **primary** footer line (line 2 of 4).
 *
 * Left side:  path cluster (working directory + branch + worktree chips).
 * Right side: MODEL | THINK | CTX chips (priority-trimmed to fit the width).
 *
 * The right-side chips are passed to `fitLeftRight` which progressively drops
 * lower-priority chips (priority 3 first, then 2) until both sides fit.
 */
export function renderPrimaryLine(
  width: number,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  runtime: RuntimeState,
): string {
  const context = runtime.context;
  const right: Chip[] = [
    // Priority 1: always shown – the model is the most important identifier.
    chip("MODEL", modelName(ctx), COLOR.model, 1, {
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
    // Priority 1: context usage – critical signal for knowing when to compact.
    chip("CTX", context.label, context.color, 1, {
      valueBg: COLOR.panelLift,
      boldValue: true,
    }),
  ];

  return fitLeftRight(width, right, (available) =>
    renderPathCluster(available, ctx, footerData),
  );
}

/**
 * Render the **usage** footer line (line 4 of 4).
 *
 * Left side:  Codex usage chip (OpenAI rate-limit / credits).
 * Right side: ↑ input tokens | ↓ output tokens | $ cost.
 *
 * The cost chip is priority 2 (dropped first) so token counts stay visible
 * on narrow terminals.
 */
export function renderUsageLine(
  width: number,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  runtime: RuntimeState,
): string {
  const totals = runtime.tokenTotals;
  const right: Chip[] = [
    chip("↑", formatCount(totals.input), COLOR.token, 1),
    chip("↓", formatCount(totals.output), COLOR.token, 1),
    chip("$", formatCost(totals.cost), COLOR.cost, 2, { boldValue: true }),
  ];

  return fitLeftRight(width, right, (available) =>
    renderCodexStatus(available, runtime, ctx),
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

// ── Path Cluster ─────────────────────────────────────────────────────

/**
 * Render the left-side "path cluster": a combination of a path chip, a git
 * branch chip (with status symbols), and an optional linked-worktree chip.
 *
 * The function tries a waterfall of progressively more compact layouts until
 * one fits within `maxWidth`.  Layout attempts (in order):
 *  1. Full widths + status indicators
 *  2. Narrower widths + status indicators
 *  3. Minimum widths + status indicators
 *  4. Narrower widths, no status symbols
 *  5. Branch only (no worktree), no status
 *  6. Worktree only (no branch), with status
 *  7. Worktree only, no status
 *  8. No branch or worktree – path chip alone
 *
 * If even the path chip alone is wider than `maxWidth`, it is hard-truncated.
 */
function renderPathCluster(
  maxWidth: number,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
): string {
  if (maxWidth <= 0) return "";

  // The footer-data provider may have a branch name from the session that is
  // more up-to-date than what `git status` returns (e.g. immediately after a
  // branch switch, before the git cache has expired).
  const footerBranch = footerData.getGitBranch() ?? undefined;
  const git = getGitSnapshot(ctx.cwd, footerBranch);
  const branch = git.branch ?? footerBranch;
  const fullPath = formatWorkingPath(ctx.cwd);

  for (const attempt of [
    { worktreeWidth: 24, branchWidth: 28, includeStatus: true },
    { worktreeWidth: 18, branchWidth: 18, includeStatus: true },
    { worktreeWidth: 12, branchWidth: 12, includeStatus: true },
    { worktreeWidth: 18, branchWidth: 18, includeStatus: false },
    { worktreeWidth: 18, branchWidth: 0,  includeStatus: false },
    { worktreeWidth: 0,  branchWidth: 18, includeStatus: true },
    { worktreeWidth: 0,  branchWidth: 18, includeStatus: false },
    { worktreeWidth: 0,  branchWidth: 0,  includeStatus: false },
  ]) {
    const worktreeChip =
      attempt.worktreeWidth > 0 && git.worktreeName
        ? renderWorktreeChip(git.worktreeName, attempt.worktreeWidth)
        : "";
    const branchChip =
      attempt.branchWidth > 0 && branch
        ? renderBranchChip(
            branch,
            attempt.branchWidth,
            attempt.includeStatus ? git.statusParts : undefined,
          )
        : "";
    const fixed = [worktreeChip, branchChip].filter(Boolean).join(" ");
    const fixedWidth = visibleWidth(fixed);
    const gap = fixedWidth > 0 ? 1 : 0;
    const pathMaxWidth = Math.max(0, maxWidth - fixedWidth - gap);
    const pathChip = renderFittedPathChip(fullPath, pathMaxWidth);
    const cluster = [pathChip, fixed].filter(Boolean).join(" ");

    if (visibleWidth(cluster) <= maxWidth) return cluster;
  }

  // Last resort: path chip alone, hard-truncated.
  return truncateToWidth(
    renderFittedPathChip(fullPath, maxWidth),
    maxWidth,
    "",
  );
}

// ── Path Chips ───────────────────────────────────────────────────────

/**
 * Render a path chip with the standard styling (sky-blue accent, bold value,
 * lifted panel background for the value area).
 */
function renderPathChip(value: string): string {
  return renderChip(
    chip("", value, COLOR.path, 1, {
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

// ── Git Chips ────────────────────────────────────────────────────────

/**
 * Render a branch chip as a segmented chip: bold branch name followed by
 * coloured status-indicator segments (e.g. `~2 +1 ✘3`).
 *
 * When `statusParts` is omitted (compact layout), only the branch name is shown.
 */
function renderBranchChip(
  branch: string,
  maxWidth: number,
  statusParts?: GitStatusPart[],
): string {
  const branchText = shorten(branch, maxWidth);
  const segments = [
    { text: branchText, fg: COLOR.git, bold: true },
    ...(statusParts ?? []).map((part) => ({
      text: `${part.symbol}${part.count}`,
      fg: part.color,
      bold: true,
    })),
  ];

  return renderSegmentedChip("", segments, COLOR.git, {
    labelFg: COLOR.black,
    valueBg: COLOR.panelLift,
  });
}

/**
 * Render the linked-worktree chip with a folder icon (󰙅) and a truncated
 * worktree name.  Priority 2: dropped before branch and path on narrow terminals.
 */
function renderWorktreeChip(worktreeName: string, maxWidth: number): string {
  return renderChip(
    chip("󰙅", shorten(worktreeName, maxWidth), COLOR.git, 2, {
      labelFg: COLOR.black,
    }),
  );
}

// ── Codex Chip ─────────────────────────────────────────────────────

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
