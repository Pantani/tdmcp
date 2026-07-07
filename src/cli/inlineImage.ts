/**
 * Terminal inline-image rendering for `tdmcp preview --inline`.
 *
 * Emits a base64 image into the terminal using whichever inline-image protocol
 * the emulator supports, detected from environment variables:
 *   - iTerm2   → the `ESC ] 1337 ; File=...` OSC sequence (inline base64).
 *   - Kitty    → the `ESC _G ... ESC \` graphics protocol (chunked base64).
 *   - sixel    → not encoded here (would need a rasteriser); falls back to ASCII.
 *   - otherwise → a coarse ASCII/no-op fallback so piping/CI never breaks.
 *
 * We keep this dependency-free: detection is by env var, and the ASCII fallback
 * is a single honest line rather than a heavy pixel-to-glyph renderer.
 */

export type InlineProtocol = "iterm2" | "kitty" | "ascii";

export interface TerminalEnv {
  TERM_PROGRAM?: string | undefined;
  TERM?: string | undefined;
  KITTY_WINDOW_ID?: string | undefined;
  LC_TERMINAL?: string | undefined;
}

/** Picks the best inline-image protocol for the current terminal. */
export function detectInlineProtocol(env: TerminalEnv = process.env): InlineProtocol {
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  const lcTerminal = (env.LC_TERMINAL ?? "").toLowerCase();
  if (termProgram.includes("iterm") || lcTerminal.includes("iterm")) return "iterm2";
  if (env.KITTY_WINDOW_ID || (env.TERM ?? "").includes("kitty")) return "kitty";
  return "ascii";
}

function itermSequence(base64: string, bytes: number): string {
  // inline=1 renders it in place; preserveAspectRatio keeps the thumbnail square-ish.
  return `\x1b]1337;File=inline=1;size=${bytes};preserveAspectRatio=1:${base64}\x07\n`;
}

function kittySequence(base64: string): string {
  // Kitty graphics protocol: a=T (transmit+display), f=100 (PNG), chunked payload.
  const CHUNK = 4096;
  const parts: string[] = [];
  for (let i = 0; i < base64.length; i += CHUNK) {
    const chunk = base64.slice(i, i + CHUNK);
    const more = i + CHUNK < base64.length ? 1 : 0;
    const control = i === 0 ? `a=T,f=100,m=${more}` : `m=${more}`;
    parts.push(`\x1b_G${control};${chunk}\x1b\\`);
  }
  return `${parts.join("")}\n`;
}

/**
 * Renders an image to a terminal control string. `mimeType` is used only to
 * label the ASCII fallback; iTerm2/Kitty accept the raw base64 either way.
 */
export function renderInlineImage(
  base64: string,
  opts: {
    protocol?: InlineProtocol;
    width?: number;
    height?: number;
    mimeType?: string;
    caption?: string;
    env?: TerminalEnv;
  } = {},
): string {
  const protocol = opts.protocol ?? detectInlineProtocol(opts.env);
  const bytes = Math.floor((base64.length * 3) / 4);
  const caption = opts.caption ? `${opts.caption}\n` : "";
  if (protocol === "iterm2") return caption + itermSequence(base64, bytes);
  if (protocol === "kitty") return caption + kittySequence(base64);
  // ASCII/no-op fallback: honest one-liner (never dumps raw base64 into a pipe).
  const dims = opts.width && opts.height ? `${opts.width}×${opts.height} ` : "";
  const kind = opts.mimeType ?? "image";
  return `${caption}[inline preview: ${dims}${kind}, ${bytes} bytes — terminal has no inline-image support; use -o <file> to save]\n`;
}
