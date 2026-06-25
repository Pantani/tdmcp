/**
 * Shared hex-color parsing for tool generators.
 *
 * Layer 1 tools used to each carry their own `hexToRgb`/`parseHexColor`/`toHex`
 * copy (~20 near-identical definitions). They varied along three axes — return
 * shape (`{ r, g, b }` vs `[r, g, b]`), whether 3-digit `#rgb` shorthand is
 * accepted, and the fallback color — so this module exposes a single parser plus
 * thin shape/fallback adapters, and every call site passes its own fallback and
 * shorthand flag. Behavior is preserved exactly per call site.
 */

export type Rgb = { r: number; g: number; b: number };

/** Case-insensitive `#rgb` or `#rrggbb` (the `#` is optional). */
const HEX_SHORTHAND_OR_FULL = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Case-insensitive `#rrggbb` only (the `#` is optional). */
const HEX_FULL = /^#?([0-9a-f]{6})$/i;

export interface ParseHexOptions {
  /** Accept 3-digit `#rgb` and expand it to `#rrggbb`. Default: false (6-digit only). */
  shorthand?: boolean;
}

/**
 * Parses a hex color into a 0..1 RGB tuple, or `undefined` for malformed input so
 * the caller can pick its own fallback. 6-digit only unless `shorthand` is set.
 */
export function parseHexColor(
  hex: string,
  options: ParseHexOptions = {},
): [number, number, number] | undefined {
  const re = options.shorthand ? HEX_SHORTHAND_OR_FULL : HEX_FULL;
  const group = re.exec(hex.trim())?.[1];
  if (!group) return undefined;
  const full = group.length === 3 ? group.replace(/./g, (c) => c + c) : group;
  const int = Number.parseInt(full, 16);
  return [((int >> 16) & 0xff) / 255, ((int >> 8) & 0xff) / 255, (int & 0xff) / 255];
}

/** {@link parseHexColor} returning the `fallback` tuple on malformed input. */
export function hexToRgbTuple(
  hex: string,
  fallback: [number, number, number],
  options?: ParseHexOptions,
): [number, number, number] {
  return parseHexColor(hex, options) ?? fallback;
}

/** {@link parseHexColor} returning an `{ r, g, b }` object, with a fallback. */
export function hexToRgb(hex: string, fallback: Rgb, options?: ParseHexOptions): Rgb {
  const rgb = parseHexColor(hex, options);
  return rgb ? { r: rgb[0], g: rgb[1], b: rgb[2] } : fallback;
}

/** Formats a 0..1 RGB tuple back to `#rrggbb` (e.g. to seed an RGB swatch control). */
export function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
