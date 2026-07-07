import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  narrateSetImpl,
  narrateSetSchema,
  registerNarrateSet,
} from "../../src/tools/ai/narrateSet.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdmcp-narrate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// narrate_set never touches TD; a client that would throw proves it stays offline.
function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

describe("narrate_set", () => {
  it("schema defaults mode=append and tail=50", () => {
    const parsed = narrateSetSchema.parse({});
    expect(parsed.mode).toBe("append");
    expect(parsed.tail).toBe(50);
  });

  it("appends a timestamped line with section + cue and writes a header on first write", async () => {
    const logPath = join(dir, "set.md");
    const result = await narrateSetImpl(makeCtx(), {
      mode: "append",
      line: "holding through the build → cue 'drop' on the next bar",
      section: "build",
      cue: "drop",
      log_path: logPath,
      tail: 50,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      appended: { section?: string; cue?: string; line: string; timestamp: string };
      count: number;
      log_path: string;
    };
    expect(structured.count).toBe(1);
    expect(structured.appended.section).toBe("build");
    expect(structured.appended.cue).toBe("drop");
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("# Set narration");
    expect(content).toContain("[build]");
    expect(content).toContain("(cue: drop)");
    expect(content).toContain("cue 'drop' on the next bar");
  });

  it("recall parses back appended entries and tails them", async () => {
    const logPath = join(dir, "set.md");
    for (let i = 0; i < 4; i++) {
      await narrateSetImpl(makeCtx(), {
        mode: "append",
        line: `move ${i}`,
        section: "drop",
        log_path: logPath,
        tail: 50,
      });
    }
    const recall = await narrateSetImpl(makeCtx(), {
      mode: "recall",
      log_path: logPath,
      tail: 2,
    });
    const structured = recall.structuredContent as {
      entries: Array<{ line: string; section?: string }>;
      count: number;
    };
    expect(structured.count).toBe(4);
    expect(structured.entries).toHaveLength(2);
    expect(structured.entries[0]?.line).toBe("move 2");
    expect(structured.entries[1]?.section).toBe("drop");
  });

  it("recall on a missing log returns an empty set, not an error", async () => {
    const result = await narrateSetImpl(makeCtx(), {
      mode: "recall",
      log_path: join(dir, "none.md"),
      tail: 50,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { count: number; entries: unknown[] };
    expect(structured.count).toBe(0);
    expect(structured.entries).toHaveLength(0);
  });

  it("append without a line is an error", async () => {
    const result = await narrateSetImpl(makeCtx(), {
      mode: "append",
      log_path: join(dir, "set.md"),
      tail: 50,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("requires a non-empty");
  });

  it("append reports a friendly error when the log directory cannot be created", async () => {
    // Point log_path at an existing *file* used as a directory segment — mkdirSync on the
    // append path fails cleanly (ENOTDIR) and surfaces a friendly error, not a throw.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const result = await narrateSetImpl(makeCtx(), {
      mode: "append",
      line: "x",
      log_path: join(blocker, "set.md"),
      tail: 50,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Could not write narration");
  });

  it("recall reports a friendly error when the log path cannot be read", async () => {
    // Point log_path at a DIRECTORY: existsSync is true so recall does not early-return,
    // but readFileSync throws EISDIR — the read-failure branch must return errorResult,
    // not throw and break the never-throw handler contract.
    const asDir = join(dir, "as-dir");
    mkdirSync(asDir, { recursive: true });
    const result = await narrateSetImpl(makeCtx(), {
      mode: "recall",
      log_path: asDir,
      tail: 50,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Could not read narration log");
  });

  it("is registered as a non-destructive local-file tool", () => {
    const calls: Array<{ name: string; options: { annotations?: Record<string, boolean> } }> = [];
    const fakeServer = {
      registerTool(name: string, options: { annotations?: Record<string, boolean> }) {
        calls.push({ name, options });
      },
    };
    registerNarrateSet(fakeServer as never, makeCtx());
    expect(calls[0]?.name).toBe("narrate_set");
    expect(calls[0]?.options.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: false,
    });
  });
});
