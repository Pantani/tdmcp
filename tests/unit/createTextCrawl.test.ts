import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildTextCrawlScript,
  createTextCrawlImpl,
  createTextCrawlSchema,
} from "../../src/tools/layer1/createTextCrawl.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  text: string;
  mode: "crawl_horizontal" | "roll_vertical" | "typewriter";
  speed: number;
  font_size: number;
  color: number[];
  bg_alpha: number;
  width: number;
  height: number;
  loop: boolean;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Representative success report for crawl_horizontal. */
function happyReport(
  overrides: Partial<{
    mode: string;
    lines: number;
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/text_crawl",
    output_top: "/project1/text_crawl/out",
    text_top: "/project1/text_crawl/text",
    transform_top: "/project1/text_crawl/pos",
    mode: overrides.mode ?? "crawl_horizontal",
    lines: overrides.lines ?? 1,
    warnings: overrides.warnings ?? [],
  });
}

/** Minimal set of args that fully satisfies the inferred type (all defaults supplied). */
const BASE_ARGS: import("../../src/tools/layer1/createTextCrawl.js").CreateTextCrawlArgs = {
  parent_path: "/project1",
  name: "text_crawl",
  text: "HELLO WORLD",
  mode: "crawl_horizontal",
  speed: 0.1,
  font_size: 48,
  color: [1, 1, 1],
  bg_alpha: 0,
  width: 1920,
  height: 1080,
  loop: true,
};

// ---------------------------------------------------------------------------
// buildTextCrawlScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildTextCrawlScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildTextCrawlScript({
      parent_path: "/project1",
      name: "crawl",
      text: "LINE ONE\nLINE TWO",
      mode: "roll_vertical",
      speed: 0.2,
      font_size: 64,
      color: [1, 0.5, 0],
      bg_alpha: 0.5,
      width: 1280,
      height: 720,
      loop: false,
    });
    const p = decodePayload(script);
    expect(p.parent_path).toBe("/project1");
    expect(p.name).toBe("crawl");
    expect(p.text).toBe("LINE ONE\nLINE TWO");
    expect(p.mode).toBe("roll_vertical");
    expect(p.speed).toBe(0.2);
    expect(p.font_size).toBe(64);
    expect(p.color).toEqual([1, 0.5, 0]);
    expect(p.bg_alpha).toBe(0.5);
    expect(p.width).toBe(1280);
    expect(p.height).toBe(720);
    expect(p.loop).toBe(false);
  });

  it("keeps user-supplied text with newlines and special chars only in the decoded blob", () => {
    const tricky = 'Line with "quotes" and \\n backslash and UNIQUEMARKER_abc123';
    const script = buildTextCrawlScript({
      parent_path: "/project1",
      name: "tc",
      text: tricky,
      mode: "crawl_horizontal",
      speed: 0.1,
      font_size: 48,
      color: [1, 1, 1],
      bg_alpha: 0,
      width: 1920,
      height: 1080,
      loop: true,
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain("UNIQUEMARKER_abc123");
    // The raw marker must not appear outside the blob in the Python template.
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_abc123");
  });

  it("script imports json and base64 and prints json.dumps(report)", () => {
    const script = buildTextCrawlScript({
      parent_path: "/project1",
      name: "tc",
      text: "HELLO",
      mode: "crawl_horizontal",
      speed: 0.1,
      font_size: 48,
      color: [1, 1, 1],
      bg_alpha: 0,
      width: 1920,
      height: 1080,
      loop: true,
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    // Key TD operator names must be present.
    expect(script).toContain("textTOP");
    expect(script).toContain("transformTOP");
    expect(script).toContain("nullTOP");
    expect(script).toContain("baseCOMP");
  });

  it("crawl_horizontal mode contains a tx expression", () => {
    const script = buildTextCrawlScript({
      parent_path: "/project1",
      name: "tc",
      text: "TICKER",
      mode: "crawl_horizontal",
      speed: 0.1,
      font_size: 48,
      color: [1, 1, 1],
      bg_alpha: 0,
      width: 1920,
      height: 1080,
      loop: true,
    });
    expect(script).toContain("_xfm.par.tx");
    expect(script).toContain("EXPRESSION");
  });

  it("roll_vertical mode contains a ty expression", () => {
    const script = buildTextCrawlScript({
      parent_path: "/project1",
      name: "tc",
      text: "CREDITS",
      mode: "roll_vertical",
      speed: 0.05,
      font_size: 48,
      color: [1, 1, 1],
      bg_alpha: 0,
      width: 1920,
      height: 1080,
      loop: true,
    });
    expect(script).toContain("_xfm.par.ty");
    expect(script).toContain("EXPRESSION");
  });

  it("typewriter mode contains a text-par expression with a slice", () => {
    const script = buildTextCrawlScript({
      parent_path: "/project1",
      name: "tc",
      text: "REVEAL ME",
      mode: "typewriter",
      speed: 0.5,
      font_size: 48,
      color: [1, 1, 1],
      bg_alpha: 0,
      width: 1920,
      height: 1080,
      loop: true,
    });
    expect(script).toContain("_txt.par.text");
    expect(script).toContain("EXPRESSION");
    // Must include the unverified warning note so callers know.
    expect(script).toContain("UNVERIFIED-live");
  });

  it("bg_alpha par probing: tries both alphabg and bgalpha", () => {
    const script = buildTextCrawlScript({
      parent_path: "/project1",
      name: "tc",
      text: "BG",
      mode: "crawl_horizontal",
      speed: 0.1,
      font_size: 48,
      color: [1, 1, 1],
      bg_alpha: 0.3,
      width: 1920,
      height: 1080,
      loop: true,
    });
    expect(script).toContain("alphabg");
    expect(script).toContain("bgalpha");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults + validation
// ---------------------------------------------------------------------------

describe("createTextCrawlSchema defaults and validation", () => {
  it("applies all documented defaults", () => {
    const parsed = createTextCrawlSchema.parse({ text: "HI" });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("text_crawl");
    expect(parsed.mode).toBe("crawl_horizontal");
    expect(parsed.speed).toBe(0.1);
    expect(parsed.font_size).toBe(48);
    expect(parsed.color).toEqual([1, 1, 1]);
    expect(parsed.bg_alpha).toBe(0);
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
    expect(parsed.loop).toBe(true);
  });

  it("requires text field (no default)", () => {
    expect(() => createTextCrawlSchema.parse({})).toThrow();
  });

  it("coerces numeric strings for speed, font_size, bg_alpha, width, height", () => {
    const parsed = createTextCrawlSchema.parse({
      text: "X",
      speed: "0.2",
      font_size: "64",
      bg_alpha: "0.5",
      width: "1280",
      height: "720",
    });
    expect(parsed.speed).toBe(0.2);
    expect(parsed.font_size).toBe(64);
    expect(parsed.bg_alpha).toBe(0.5);
    expect(parsed.width).toBe(1280);
    expect(parsed.height).toBe(720);
  });

  it("rejects bg_alpha > 1", () => {
    expect(() => createTextCrawlSchema.parse({ text: "X", bg_alpha: 1.5 })).toThrow();
  });

  it("rejects bg_alpha < 0", () => {
    expect(() => createTextCrawlSchema.parse({ text: "X", bg_alpha: -0.1 })).toThrow();
  });

  it("rejects an invalid mode", () => {
    expect(() => createTextCrawlSchema.parse({ text: "X", mode: "bounce" })).toThrow();
  });

  it("rejects color array of wrong length", () => {
    expect(() => createTextCrawlSchema.parse({ text: "X", color: [1, 1] })).toThrow();
  });

  it("accepts roll_vertical and typewriter modes", () => {
    expect(createTextCrawlSchema.parse({ text: "X", mode: "roll_vertical" }).mode).toBe(
      "roll_vertical",
    );
    expect(createTextCrawlSchema.parse({ text: "X", mode: "typewriter" }).mode).toBe("typewriter");
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createTextCrawlImpl — happy path", () => {
  it("returns a non-error result with a summary containing mode and output", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createTextCrawlImpl(fakeCtx(exec), BASE_ARGS);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("horizontal crawl");
    expect(text).toContain("/project1/text_crawl/out");
    expect(text).toContain("speed 0.1");
  });

  it("sends the correct payload (all fields)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTextCrawlImpl(fakeCtx(exec), BASE_ARGS);
    const p = decodePayload(scriptArg(exec));
    expect(p.parent_path).toBe("/project1");
    expect(p.name).toBe("text_crawl");
    expect(p.text).toBe("HELLO WORLD");
    expect(p.mode).toBe("crawl_horizontal");
    expect(p.speed).toBe(0.1);
    expect(p.font_size).toBe(48);
    expect(p.color).toEqual([1, 1, 1]);
    expect(p.bg_alpha).toBe(0);
    expect(p.width).toBe(1920);
    expect(p.height).toBe(1080);
    expect(p.loop).toBe(true);
  });

  it("includes multi-line line count in summary", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ lines: 5 }),
    }));
    const result = await createTextCrawlImpl(fakeCtx(exec), {
      ...BASE_ARGS,
      text: "A\nB\nC\nD\nE",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("5 lines");
  });

  it("reports warning count in summary when warnings present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ warnings: ["bg_alpha par not found", "fontsizey failed"] }),
    }));
    const result = await createTextCrawlImpl(fakeCtx(exec), BASE_ARGS);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("2 warning(s)");
  });

  it("typewriter mode summary notes UNVERIFIED-live", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ mode: "typewriter" }),
    }));
    const result = await createTextCrawlImpl(fakeCtx(exec), {
      ...BASE_ARGS,
      mode: "typewriter",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("UNVERIFIED-live");
  });

  it("roll_vertical mode label appears in summary", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ mode: "roll_vertical" }),
    }));
    const result = await createTextCrawlImpl(fakeCtx(exec), {
      ...BASE_ARGS,
      mode: "roll_vertical",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("vertical roll");
  });
});

// ---------------------------------------------------------------------------
// Fatal — parent COMP missing
// ---------------------------------------------------------------------------

describe("createTextCrawlImpl — fatal (parent not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        output_top: "",
        text_top: "",
        transform_top: "",
        mode: "crawl_horizontal",
        lines: 1,
        warnings: [],
        fatal: "Parent COMP not found: /project1/missing",
      }),
    }));
    const result = await createTextCrawlImpl(fakeCtx(exec), {
      ...BASE_ARGS,
      parent_path: "/project1/missing",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createTextCrawlImpl — TD offline", () => {
  it("returns isError:true and does not throw when bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createTextCrawlImpl(fakeCtx(exec), BASE_ARGS);
    expect(result.isError).toBe(true);
  });
});
