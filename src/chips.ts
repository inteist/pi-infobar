import type { Chip } from "./types.js";
import { ansi, readableTextOn } from "./ansi.js";
import { COLOR } from "./theme.js";

// ── Chip Factory ─────────────────────────────────────────────────────

/**
 * Construct a {@link Chip} data object from its constituent parts.
 *
 * @param label     Short uppercase label shown in the accent-coloured left section
 *                  (e.g. `"anthropic"`, `"CTX"`). Pass `""` for label-less chips.
 * @param value     The dynamic value shown in the value section (e.g. `"claude-3-5"`).
 * @param accent    Hex colour for the label background and chip borders.
 * @param priority  Render priority used by `fitLeftRight` when dropping chips on
 *                  narrow terminals: 1 = always shown, 2 = dropped second, 3 = first.
 * @param options   Optional overrides for foreground/background colours and bold.
 */
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

/**
 * Render an array of chips as a space-separated string.
 * Each chip is rendered with `renderChip`; callers are responsible for
 * filtering out chips that should not be shown.
 */
export function renderChips(chips: Chip[]): string {
  return chips.map(renderChip).join(" ");
}

/**
 * Render a single chip using Powerline-style arrow separators and ANSI colours.
 *
 * Visual structure (nerd-font glyphs):
 *   `` <label> `` <value> ``
 *   └─ accent bg ─┘└── valueBg ──┘
 *
 * The leading `` and trailing `` glyphs create a "pill" shape by
 * transitioning between the panel background and the chip colours.
 *
 * Colour resolution:
 *  - `labelFg` defaults to black or white chosen for readability on `accent`.
 *  - `valueFg` defaults to the `accent` colour (coloured text on dark bg).
 *  - `valueBg` defaults to `COLOR.panel` (the standard footer panel colour).
 */
export function renderChip(item: Chip): string {
  const labelFg = item.labelFg ?? readableTextOn(item.accent);
  const valueFg = item.valueFg ?? item.accent;
  const valueBg = item.valueBg ?? COLOR.panel;

  return [
    ansi("", { fg: item.accent }), // opening arrow
    ansi(` ${item.label} `, { fg: labelFg, bg: item.accent, bold: true }), // label section
    ansi("", { fg: item.accent, bg: valueBg }), // separator arrow
    ansi(` ${item.value} `, { fg: valueFg, bg: valueBg, bold: item.boldValue }), // value section
    ansi("", { fg: valueBg }), // closing arrow
  ].join("");
}

/**
 * Render a chip whose value area consists of multiple independently-coloured
 * text segments rather than a single string.  Used by the branch chip (branch
 * name + status indicators) and the Codex usage chip (percentage + reset time).
 *
 * The label section uses the same Powerline arrow style as `renderChip`.
 * Segments are concatenated with a thin space between them so they visually
 * group within the shared value background.
 *
 * @param label     The chip label (can be empty `""` for label-less chips).
 * @param segments  Ordered list of `{ text, fg, bold? }` value segments.
 * @param accent    Hex colour for the label background and border arrows.
 * @param options   Optional `labelFg` and `valueBg` overrides.
 */
export function renderSegmentedChip(
  label: string,
  segments: Array<{ text: string; fg: string; bold?: boolean }>,
  accent: string,
  options: { labelFg?: string; valueBg?: string } = {},
): string {
  const labelFg = options.labelFg ?? readableTextOn(accent);
  const valueBg = options.valueBg ?? COLOR.panel;

  // Build the concatenated value string: each segment (except the first)
  // is preceded by a space character that inherits the valueBg colour so it
  // blends into the background rather than appearing as a raw space.
  const value = segments
    .map((segment, index) => {
      const prefix = index === 0 ? "" : ansi(" ", { bg: valueBg });
      return `${prefix}${ansi(segment.text, { fg: segment.fg, bg: valueBg, bold: segment.bold })}`;
    })
    .join("");

  return [
    ansi("", { fg: accent }), // opening arrow
    ansi(` ${label} `, { fg: labelFg, bg: accent, bold: true }), // label section
    ansi("", { fg: accent, bg: valueBg }), // separator arrow
    ansi(" ", { bg: valueBg }), // left padding
    value,
    ansi(" ", { bg: valueBg }), // right padding
    ansi("", { fg: valueBg }), // closing arrow
  ].join("");
}
