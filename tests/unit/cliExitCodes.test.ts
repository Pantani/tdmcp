import { describe, expect, it } from "vitest";
import { classifyTdErrorExit, ExitCode } from "../../src/cli/exitCodes.js";
import { detectInlineProtocol, renderInlineImage } from "../../src/cli/inlineImage.js";

describe("exit-code taxonomy", () => {
  it("classifies the TouchDesignerClient connection message as TD offline (3)", () => {
    const msg =
      "Cannot reach TouchDesigner at http://127.0.0.1:9980. Make sure TD is running with the tdmcp bridge.";
    expect(classifyTdErrorExit(msg)).toBe(ExitCode.TdOffline);
  });

  it("classifies a timeout as TD offline (3)", () => {
    expect(
      classifyTdErrorExit("TouchDesigner request timed out after 5000ms (POST /api/exec)."),
    ).toBe(ExitCode.TdOffline);
  });

  it("classifies raw socket errors as TD offline (3)", () => {
    expect(classifyTdErrorExit("fetch failed: ECONNREFUSED 127.0.0.1:9980")).toBe(
      ExitCode.TdOffline,
    );
    expect(classifyTdErrorExit("socket hang up")).toBe(ExitCode.TdOffline);
  });

  it("classifies a reached-but-failed op as TD error (4)", () => {
    expect(
      classifyTdErrorExit("get_inline_preview failed at /project1/top1: Not found: /project1/top1"),
    ).toBe(ExitCode.TdError);
    expect(classifyTdErrorExit("No such parameter 'wibble' on /project1/noise1")).toBe(
      ExitCode.TdError,
    );
  });

  it("keeps the numeric contract stable", () => {
    expect(ExitCode.Ok).toBe(0);
    expect(ExitCode.Usage).toBe(2);
    expect(ExitCode.TdOffline).toBe(3);
    expect(ExitCode.TdError).toBe(4);
  });
});

describe("inline-image protocol detection", () => {
  it("detects iTerm2 from TERM_PROGRAM", () => {
    expect(detectInlineProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
  });

  it("detects Kitty from KITTY_WINDOW_ID", () => {
    expect(detectInlineProtocol({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(detectInlineProtocol({ TERM: "xterm-kitty" })).toBe("kitty");
  });

  it("falls back to ascii for a plain terminal", () => {
    expect(detectInlineProtocol({ TERM: "xterm-256color" })).toBe("ascii");
    expect(detectInlineProtocol({})).toBe("ascii");
  });
});

describe("renderInlineImage", () => {
  const b64 = Buffer.from("PNGDATA").toString("base64");

  it("emits the iTerm2 OSC 1337 sequence with inline=1", () => {
    const out = renderInlineImage(b64, { protocol: "iterm2", width: 64, height: 64 });
    expect(out).toContain("]1337;File=inline=1;");
    expect(out).toContain(b64);
  });

  it("emits a Kitty graphics escape", () => {
    const out = renderInlineImage(b64, { protocol: "kitty" });
    expect(out).toContain("_Ga=T,f=100");
    expect(out).toContain(b64);
  });

  it("emits an honest ascii fallback (never raw base64 into a pipe)", () => {
    const out = renderInlineImage(b64, {
      protocol: "ascii",
      width: 64,
      height: 64,
      mimeType: "image/png",
    });
    expect(out).toContain("inline preview");
    expect(out).toContain("64×64");
    expect(out).not.toContain(b64);
  });
});
