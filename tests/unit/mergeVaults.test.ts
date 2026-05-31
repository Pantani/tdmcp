import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import { mergeVaultsImpl } from "../../src/tools/vault/mergeVaults.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function makeCtx(vaultPath?: string): ToolContext {
  return {
    client: {} as ToolContext["client"],
    knowledge: {} as ToolContext["knowledge"],
    recipes: [] as unknown as ToolContext["recipes"],
    logger: silentLogger,
    vault: vaultPath ? new Vault(vaultPath, silentLogger) : undefined,
    allowRawPython: false,
  };
}

// Build fixture vaults in a temp dir
function buildFixtures(root: string): { src: string; tgt: string } {
  const src = join(root, "source");
  const tgt = join(root, "target");

  // source/Recipes/identical.md (sha A)
  mkdirSync(join(src, "Recipes"), { recursive: true });
  writeFileSync(join(src, "Recipes", "identical.md"), "content A");
  // source/Recipes/conflict.md (sha B)
  writeFileSync(join(src, "Recipes", "conflict.md"), "content B");
  // source/Recipes/new.md (sha C)
  writeFileSync(join(src, "Recipes", "new.md"), "content C");
  // source/Components/widget.tox (binary sha D)
  mkdirSync(join(src, "Components"), { recursive: true });
  writeFileSync(join(src, "Components", "widget.tox"), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  // source/Components/widget.md (sha E)
  writeFileSync(join(src, "Components", "widget.md"), "content E");

  // target/Recipes/identical.md (sha A — same)
  mkdirSync(join(tgt, "Recipes"), { recursive: true });
  writeFileSync(join(tgt, "Recipes", "identical.md"), "content A");
  // target/Recipes/conflict.md (sha B' — differs)
  writeFileSync(join(tgt, "Recipes", "conflict.md"), "content B prime");
  // target/Components/widget.md (sha E'' — differs)
  mkdirSync(join(tgt, "Components"), { recursive: true });
  writeFileSync(join(tgt, "Components", "widget.md"), "content E double prime");

  return { src, tgt };
}

let tmpRoot: string;
let src: string;
let tgt: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "merge-vaults-test-"));
  const f = buildFixtures(tmpRoot);
  src = f.src;
  tgt = f.tgt;
});

describe("mergeVaults", () => {
  it("dryRun produces a plan, writes nothing", async () => {
    const ctx = makeCtx(tgt);
    const result = await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "rename",
      kinds: ["all"],
      dryRun: true,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0];
    expect(text?.type).toBe("text");
    expect((text as { type: string; text: string }).text).toContain("[dry-run]");
    // No Merge-Logs written
    expect(existsSync(join(tgt, "Merge-Logs"))).toBe(false);
    // target conflict.md unchanged
    expect(readFileSync(join(tgt, "Recipes", "conflict.md"), "utf8")).toBe("content B prime");
  });

  it("strategy=rename writes side-by-side files, originals untouched", async () => {
    const ctx = makeCtx(tgt);
    await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "rename",
      kinds: ["all"],
      dryRun: false,
    });
    expect(readFileSync(join(tgt, "Recipes", "conflict.md"), "utf8")).toBe("content B prime");
    expect(existsSync(join(tgt, "Recipes", "conflict.from-source.md"))).toBe(true);
    expect(readFileSync(join(tgt, "Recipes", "conflict.from-source.md"), "utf8")).toBe("content B");
    expect(existsSync(join(tgt, "Components", "widget.from-source.md"))).toBe(true);
    expect(readFileSync(join(tgt, "Components", "widget.from-source.md"), "utf8")).toBe(
      "content E",
    );
  });

  it("strategy=theirs overwrites conflicting files with source bytes", async () => {
    const srcConflict = readFileSync(join(src, "Recipes", "conflict.md"));
    const ctx = makeCtx(tgt);
    await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "theirs",
      kinds: ["all"],
      dryRun: false,
    });
    const afterBytes = readFileSync(join(tgt, "Recipes", "conflict.md"));
    expect(sha256(afterBytes)).toBe(sha256(srcConflict));
  });

  it("strategy=ours makes no changes to conflicting files", async () => {
    const ctx = makeCtx(tgt);
    const result = await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "ours",
      kinds: ["all"],
      dryRun: false,
    });
    expect(readFileSync(join(tgt, "Recipes", "conflict.md"), "utf8")).toBe("content B prime");
    const data = result.structuredContent as { entries: Array<{ action: string }> };
    const oursEntry = data.entries.find((e) => e.action === "ours");
    expect(oursEntry).toBeDefined();
  });

  it("strategy=skip makes no changes to conflicting files", async () => {
    const ctx = makeCtx(tgt);
    const result = await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "skip",
      kinds: ["all"],
      dryRun: false,
    });
    expect(readFileSync(join(tgt, "Recipes", "conflict.md"), "utf8")).toBe("content B prime");
    const data = result.structuredContent as { entries: Array<{ action: string }> };
    const skipEntry = data.entries.find((e) => e.action === "skip");
    expect(skipEntry).toBeDefined();
  });

  it("add action copies new files (text + binary) byte-equal", async () => {
    const ctx = makeCtx(tgt);
    await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "rename",
      kinds: ["all"],
      dryRun: false,
    });
    // new.md (text)
    expect(readFileSync(join(tgt, "Recipes", "new.md"), "utf8")).toBe("content C");
    // widget.tox (binary)
    const srcBin = readFileSync(join(src, "Components", "widget.tox"));
    const tgtBin = readFileSync(join(tgt, "Components", "widget.tox"));
    expect(sha256(tgtBin)).toBe(sha256(srcBin));
  });

  it("identical files are not rewritten (no target changes)", async () => {
    const ctx = makeCtx(tgt);
    const result = await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "rename",
      kinds: ["all"],
      dryRun: false,
    });
    const data = result.structuredContent as {
      entries: Array<{ action: string; sourceRel: string }>;
    };
    const idEntry = data.entries.find((e) => e.action === "identical");
    expect(idEntry).toBeDefined();
    expect(idEntry?.sourceRel).toContain("identical.md");
  });

  it("merge log is written to Merge-Logs/<ts>.md in target", async () => {
    const ctx = makeCtx(tgt);
    const result = await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "rename",
      kinds: ["all"],
      dryRun: false,
    });
    const data = result.structuredContent as { logPath?: string };
    expect(data.logPath).toBeDefined();
    if (!data.logPath) throw new Error("logPath should be defined");
    const logContent = readFileSync(join(tgt, data.logPath), "utf8");
    expect(logContent).toContain("# Vault merge");
    expect(logContent).toContain("source:");
    expect(logContent).toContain("target:");
    expect(logContent).toContain("strategy: rename");
  });

  it("refuses when source === target", async () => {
    const ctx = makeCtx(tgt);
    const result = await mergeVaultsImpl(ctx, {
      sourceVaultPath: tgt,
      strategy: "rename",
      kinds: ["all"],
      dryRun: false,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0] as { type: string; text: string };
    expect(text.text).toContain("same");
  });

  it("refuses when no vault configured and no targetVaultPath given", async () => {
    const ctx = makeCtx(); // no vault
    const result = await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "rename",
      kinds: ["all"],
      dryRun: false,
    });
    expect(result.isError).toBe(true);
  });

  it("kinds filter restricts to selected folders only", async () => {
    const ctx = makeCtx(tgt);
    const result = await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "rename",
      kinds: ["recipes"],
      dryRun: false,
    });
    const data = result.structuredContent as { entries: Array<{ kind: string }> };
    const componentEntries = data.entries.filter((e) => e.kind === "components");
    expect(componentEntries).toHaveLength(0);
    const recipeEntries = data.entries.filter((e) => e.kind === "recipes");
    expect(recipeEntries.length).toBeGreaterThan(0);
  });

  it("rename suffix uniquification writes -2 when primary rename already exists", async () => {
    // Pre-create the rename target
    writeFileSync(join(tgt, "Recipes", "conflict.from-source.md"), "already here");
    const ctx = makeCtx(tgt);
    await mergeVaultsImpl(ctx, {
      sourceVaultPath: src,
      strategy: "rename",
      kinds: ["recipes"],
      dryRun: false,
    });
    expect(existsSync(join(tgt, "Recipes", "conflict.from-source-2.md"))).toBe(true);
  });
});
