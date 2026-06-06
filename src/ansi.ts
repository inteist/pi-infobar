import { COLOR } from "./theme.js";

// ── ANSI Escape Helpers ──────────────────────────────────────────────

/** Apply SGR (Select Graphic Rendition) codes around `text`. */
export function ansi(
  text: string,
  options: { fg?: string; bg?: string; bold?: boolean },
): string {
  const codes = [
    options.bold ? "1" : undefined,
    options.fg ? rgbCode("38", options.fg) : undefined,
    options.bg ? rgbCode("48", options.bg) : undefined,
  ].filter((code): code is string => code !== undefined);

  if (codes.length === 0) return text;
  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}

/** Strip all ANSI escape sequences from a string. */
export function stripAnsi(value: string): string {
  return value.replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

/** Pick a readable text color (black or white) for a given background. */
export function readableTextOn(hex: string): string {
  const { red, green, blue } = hexToRgb(hex);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.55 ? COLOR.black : COLOR.ink;
}

// ── Internal ─────────────────────────────────────────────────────────

function rgbCode(prefix: "38" | "48", hex: string): string {
  const { red, green, blue } = hexToRgb(hex);
  return `${prefix};2;${red};${green};${blue}`;
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const normalized = hex.replace(/^#/, "");
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}
