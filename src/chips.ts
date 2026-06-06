import type { Chip } from "./types.js";
import { ansi, readableTextOn } from "./ansi.js";
import { COLOR } from "./theme.js";

// ── Chip Factory ─────────────────────────────────────────────────────

export function chip(
  label: string,
  value: string,
  accent: string,
  priority: 1 | 2 | 3,
  options: Partial<Pick<Chip, "labelFg" | "valueFg" | "valueBg" | "boldValue">> = {},
): Chip {
  return {
    label,
    value,
    accent,
    priority,
    labelFg: options.labelFg,
    valueFg: options.valueFg,
    valueBg: options.valueBg,
    boldValue: options.boldValue,
  };
}

// ── Chip Renderers ───────────────────────────────────────────────────

export function renderChips(chips: Chip[]): string {
  return chips.map(renderChip).join(" ");
}

export function renderChip(item: Chip): string {
  const labelFg = item.labelFg ?? readableTextOn(item.accent);
  const valueFg = item.valueFg ?? item.accent;
  const valueBg = item.valueBg ?? COLOR.panel;

  return [
    ansi("", { fg: item.accent }),
    ansi(` ${item.label} `, { fg: labelFg, bg: item.accent, bold: true }),
    ansi("", { fg: item.accent, bg: valueBg }),
    ansi(` ${item.value} `, { fg: valueFg, bg: valueBg, bold: item.boldValue }),
    ansi("", { fg: valueBg }),
  ].join("");
}

export function renderSegmentedChip(
  label: string,
  segments: Array<{ text: string; fg: string; bold?: boolean }>,
  accent: string,
  options: { labelFg?: string; valueBg?: string } = {},
): string {
  const labelFg = options.labelFg ?? readableTextOn(accent);
  const valueBg = options.valueBg ?? COLOR.panel;
  const value = segments
    .map((segment, index) => {
      const prefix = index === 0 ? "" : ansi(" ", { bg: valueBg });
      return `${prefix}${ansi(segment.text, { fg: segment.fg, bg: valueBg, bold: segment.bold })}`;
    })
    .join("");

  return [
    ansi("", { fg: accent }),
    ansi(` ${label} `, { fg: labelFg, bg: accent, bold: true }),
    ansi("", { fg: accent, bg: valueBg }),
    ansi(" ", { bg: valueBg }),
    value,
    ansi(" ", { bg: valueBg }),
    ansi("", { fg: valueBg }),
  ].join("");
}
