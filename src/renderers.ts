import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { ansi } from "./ansi.js";
import { chip, renderChip, renderChips, renderSegmentedChip } from "./chips.js";
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

export function renderPrimaryLine(
  width: number,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  runtime: RuntimeState,
): string {
  const context = runtime.context;
  const right: Chip[] = [
    chip("MODEL", modelName(ctx), COLOR.model, 1, {
      valueBg: COLOR.panelLift,
      boldValue: true,
    }),
    chip(
      "THINK",
      formatThinking(runtime.thinkingLevel),
      thinkingColor(runtime.thinkingLevel),
      2,
      {
        valueBg: COLOR.panelLift,
      },
    ),
    chip("CTX", context.label, context.color, 1, {
      valueBg: COLOR.panelLift,
      boldValue: true,
    }),
  ];

  return fitLeftRight(width, right, (available) =>
    renderPathCluster(available, ctx, footerData),
  );
}

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

export function renderSeparatorLine(width: number, separate?: string): string {
  return ansi(separate ?? "─".repeat(Math.max(0, width)), {
    fg: COLOR.separator,
  });
}

// ── Layout ───────────────────────────────────────────────────────────

function fitLeftRight(
  width: number,
  rightChips: Chip[],
  renderLeft: (available: number) => string,
): string {
  for (let priority = 3; priority >= 1; priority -= 1) {
    const right = renderChips(
      rightChips.filter((item) => item.priority <= priority),
    );
    const rightWidth = visibleWidth(right);
    const gap = rightWidth > 0 ? 1 : 0;
    const availableLeft = Math.max(0, width - rightWidth - gap);
    const left = renderLeft(availableLeft);
    const leftWidth = visibleWidth(left);

    if (leftWidth + rightWidth + gap <= width) {
      const padding = " ".repeat(Math.max(gap, width - leftWidth - rightWidth));
      return truncateToWidth(`${left}${padding}${right}`, width, "");
    }
  }

  return truncateToWidth(renderLeft(width), width, "");
}

// ── Path Cluster ─────────────────────────────────────────────────────

function renderPathCluster(
  maxWidth: number,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
): string {
  if (maxWidth <= 0) return "";

  const footerBranch = footerData.getGitBranch() ?? undefined;
  const git = getGitSnapshot(ctx.cwd, footerBranch);
  const branch = git.branch ?? footerBranch;
  const fullPath = formatWorkingPath(ctx.cwd);

  for (const attempt of [
    { worktreeWidth: 24, branchWidth: 28, includeStatus: true },
    { worktreeWidth: 18, branchWidth: 18, includeStatus: true },
    { worktreeWidth: 12, branchWidth: 12, includeStatus: true },
    { worktreeWidth: 18, branchWidth: 18, includeStatus: false },
    { worktreeWidth: 18, branchWidth: 0, includeStatus: false },
    { worktreeWidth: 0, branchWidth: 18, includeStatus: true },
    { worktreeWidth: 0, branchWidth: 18, includeStatus: false },
    { worktreeWidth: 0, branchWidth: 0, includeStatus: false },
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

  return truncateToWidth(
    renderFittedPathChip(fullPath, maxWidth),
    maxWidth,
    "",
  );
}

// ── Path Chips ───────────────────────────────────────────────────────

function renderPathChip(value: string): string {
  return renderChip(
    chip("", value, COLOR.path, 1, {
      labelFg: COLOR.black,
      valueBg: COLOR.panelLift,
      boldValue: true,
    }),
  );
}

function renderFittedPathChip(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  const fullPathChip = renderPathChip(path);
  if (visibleWidth(fullPathChip) <= maxWidth) return fullPathChip;

  const emptyPathChipWidth = visibleWidth(renderPathChip(""));
  const pathWidth = Math.max(3, maxWidth - emptyPathChipWidth);
  return truncateToWidth(
    renderPathChip(smartPathTruncate(path, pathWidth)),
    maxWidth,
    "",
  );
}

// ── Git Chips ────────────────────────────────────────────────────────

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

  return renderSegmentedChip("", segments, COLOR.git, {
    labelFg: COLOR.black,
    valueBg: COLOR.panelLift,
  });
}

function renderWorktreeChip(worktreeName: string, maxWidth: number): string {
  return renderChip(
    chip("󰙅", shorten(worktreeName, maxWidth), COLOR.git, 2, {
      labelFg: COLOR.black,
    }),
  );
}

// ── Codex Chip ─────────────────────────────────────────────────────

function renderCodexStatus(
  maxWidth: number,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): string {
  if (maxWidth <= 0) return "";

  const manager = runtime.codexUsage;
  const report = manager.getReport();
  if (!report && manager.state === "idle") return "";

  const data = formatCodexChipData(report, manager.state, ctx.model);
  const accent = data.accent;
  const labelFg =
    accent === COLOR.contextWarn || accent === COLOR.codex
      ? COLOR.black
      : COLOR.ink;

  const full = renderSegmentedChip("CODEX", data.segments, accent, {
    labelFg,
    valueBg: COLOR.panelLift,
  });
  if (visibleWidth(full) <= maxWidth) return full;

  const emptyWidth = visibleWidth(
    renderChip(
      chip("CODEX", "", accent, 1, { labelFg, valueBg: COLOR.panelLift }),
    ),
  );
  const valueWidth = Math.max(1, maxWidth - emptyWidth);
  return truncateToWidth(
    renderChip(
      chip("CODEX", truncateToWidth(data.text, valueWidth, "…"), accent, 1, {
        labelFg,
        valueBg: COLOR.panelLift,
        boldValue: manager.state === "loaded",
      }),
    ),
    maxWidth,
    "",
  );
}
