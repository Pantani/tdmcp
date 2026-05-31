import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import {
  CORPUS_STYLE_TOPIC,
  clusterPalettes,
  extractStyle,
  type LearnFromMyCorpusArgs,
  learnFromMyCorpusImpl,
  learnFromMyCorpusSchema,
  scanCorpus,
  signatureForRecipe,
} from "../../src/tools/vault/learnFromMyCorpus.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { memoryNoteRel, STYLE_NOTE_REL } from "../../src/vault/memoryNote.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tdmcp-corpus-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function fakeCtx(vault?: Vault): ToolContext {
  return {
    client: {},
    logger: silentLogger,
    ...(vault ? { vault } : {}),
  } as unknown as ToolContext;
}

function defaults(over: Partial<LearnFromMyCorpusArgs> = {}): LearnFromMyCorpusArgs {
  return learnFromMyCorpusSchema.parse(over);
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function dataOf(result: CallToolResult): Record<string, unknown> | undefined {
  const m = textOf(result).match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) return undefined;
  return JSON.parse(m[1]) as Record<string, unknown>;
}

function writeYaml(dir: string, rel: string, fm: Record<string, unknown>, body = ""): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(full, `---\n${yaml}\n---\n${body}`, "utf8");
}

function writeJson(dir: string, rel: string, obj: unknown): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, JSON.stringify(obj, null, 2), "utf8");
}

function makeFixtureVault(): { dir: string; vault: Vault } {
  const dir = makeTmp();
  // 3 feedback-tunnel recipes (same signature)
  for (let i = 1; i <= 3; i++) {
    writeJson(dir, `Recipes/feedback-tunnel-${i}.json`, {
      id: `fb-${i}`,
      name: `feedback tunnel ${i}`,
      nodes: [
        { name: `fbTunnel${i}`, type: "feedbackTOP", parameters: { color: "#1a1a2e" } },
        { name: `noise${i}`, type: "noiseTOP", parameters: { tint: "#e94560" } },
        { name: `out${i}`, type: "outTOP", parameters: {} },
      ],
      connections: [
        { from: `fbTunnel${i}`, to: `noise${i}` },
        { from: `noise${i}`, to: `out${i}` },
      ],
    });
  }
  // glitch-pass with unique signature (support=1)
  writeJson(dir, "Recipes/glitch-pass.json", {
    id: "glitch",
    name: "glitch",
    nodes: [
      { name: "glitchA", type: "compositeTOP", parameters: {} },
      { name: "glitchB", type: "blurTOP", parameters: {} },
    ],
    connections: [],
  });
  // Components
  writeYaml(dir, "Components/fb_tunnel_warm.md", {
    name: "fbTunnel",
    palette: ["#1a1a2e", "#e94560", "#f5a623"],
  });
  writeYaml(dir, "Components/fb_tunnel_cool.md", {
    name: "fbTunnelCool",
    palette: ["#1a1a2e", "#e94560", "#3b82f6"],
  });
  // Looks
  writeYaml(dir, "Looks/dusk.md", {
    palettes: [{ name: "warm-dusk", colors: ["#1a1a2e", "#e94560", "#f5a623"] }],
  });
  writeYaml(dir, "Looks/dusk2.md", {
    palettes: [{ name: "warm-dusk", colors: ["#1a1a2e", "#e94560", "#f5a623"] }],
  });
  writeYaml(dir, "Looks/dusk3.md", {
    palettes: [{ name: "warm-dusk", colors: ["#1a1a2e", "#e94560", "#f5a623"] }],
  });
  // Memory/style.md (prior — must not be folded back)
  writeYaml(
    dir,
    "Memory/style.md",
    {
      type: "tdmcp-memory",
      topic: "style",
      banned: ["strobe"],
      palettes: [],
      favorite_generators: [],
      tags: [],
      updated: "2026-01-01",
    },
    "## Style notes\n",
  );
  return { dir, vault: new Vault(dir) };
}

describe("signatureForRecipe", () => {
  it("sorts types and buckets edge count", () => {
    const a = signatureForRecipe([{ type: "noiseTOP" }, { type: "feedbackTOP" }], 2);
    const b = signatureForRecipe([{ type: "feedbackTOP" }, { type: "noiseTOP" }], 2);
    expect(a.signature).toBe(b.signature);
    expect(a.types).toEqual(["feedbackTOP", "noiseTOP"]);
  });
});

describe("clusterPalettes", () => {
  it("groups by name and applies top-k", () => {
    const groups = [
      { name: "warm", colors: ["#111111", "#222222", "#333333"], source: "a" },
      { name: "warm", colors: ["#111111", "#222222", "#333333"], source: "b" },
      { name: "warm", colors: ["#111111", "#222222", "#333333"], source: "c" },
      { name: "cool", colors: ["#000000", "#111111", "#222222"], source: "d" },
    ];
    const out = clusterPalettes(groups, 5, 3);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.name).toBe("warm");
    expect(out[0]?.count).toBe(3);
  });

  it("skips palettes with fewer than 3 colours", () => {
    const out = clusterPalettes([{ colors: ["#111111", "#222222"], source: "a" }], 5, 1);
    expect(out).toEqual([]);
  });
});

describe("extractStyle", () => {
  it("filters recipe shapes below min_support", () => {
    const { vault } = makeFixtureVault();
    const stats = scanCorpus(vault, defaults());
    const out = extractStyle(stats, defaults({ min_support: 5 }));
    expect(out.recipe_shapes ?? []).toEqual([]);
  });

  it("omits families not requested", () => {
    const { vault } = makeFixtureVault();
    const stats = scanCorpus(vault, defaults());
    const out = extractStyle(stats, defaults({ observe: ["palette"] }));
    expect(out.naming).toBeUndefined();
    expect(out.recipe_shapes).toBeUndefined();
    expect(out.param_defaults).toBeUndefined();
    expect(out.palettes).toBeDefined();
  });
});

describe("learnFromMyCorpusImpl", () => {
  it("happy path writes corpus_style note with palette + naming + shapes", async () => {
    const { dir, vault } = makeFixtureVault();
    const ctx = fakeCtx(vault);
    const result = await learnFromMyCorpusImpl(ctx, defaults());
    expect(result.isError).not.toBe(true);
    const data = dataOf(result);
    expect(data?.wrote_note).toBe(true);
    const cs = data?.corpus_style as Record<string, unknown>;
    expect(Array.isArray(cs.palettes)).toBe(true);
    const palettes = cs.palettes as Array<{ name?: string; count: number }>;
    expect(palettes.some((p) => p.name === "warm-dusk")).toBe(true);
    const shapes = cs.recipe_shapes as Array<{ count: number }>;
    expect(shapes.some((s) => s.count >= 3)).toBe(true);
    // file written
    expect(vault.exists(memoryNoteRel(CORPUS_STYLE_TOPIC))).toBe(true);
    void dir;
  });

  it("dry_run: true does not write", async () => {
    const { vault } = makeFixtureVault();
    // remove the note path first by ensuring it doesn't exist
    const noteRel = memoryNoteRel(CORPUS_STYLE_TOPIC);
    expect(vault.exists(noteRel)).toBe(false);
    const result = await learnFromMyCorpusImpl(fakeCtx(vault), defaults({ dry_run: true }));
    const data = dataOf(result);
    expect(data?.wrote_note).toBe(false);
    expect(vault.exists(noteRel)).toBe(false);
  });

  it("also_patch_style_memory merges palettes without losing prior banned list", async () => {
    const { vault } = makeFixtureVault();
    await learnFromMyCorpusImpl(fakeCtx(vault), defaults({ also_patch_style_memory: true }));
    const style = vault.readNote(STYLE_NOTE_REL);
    const fm = style.data as Record<string, unknown>;
    expect((fm.banned as string[]).includes("strobe")).toBe(true);
    const palettes = fm.palettes as Array<{ name?: string }>;
    expect(palettes.some((p) => p.name === "warm-dusk")).toBe(true);
  });

  it("missing subdirs produce warnings, no throw", async () => {
    const dir = makeTmp();
    writeJson(dir, "Recipes/r.json", {
      id: "x",
      name: "x",
      nodes: [{ name: "a", type: "noiseTOP", parameters: {} }],
      connections: [],
    });
    const vault = new Vault(dir);
    const result = await learnFromMyCorpusImpl(fakeCtx(vault), defaults());
    expect(result.isError).not.toBe(true);
    const data = dataOf(result);
    const warnings = (data?.corpus_style as Record<string, unknown>).warnings as string[];
    expect(warnings.some((w) => w.includes("Components"))).toBe(true);
    expect(warnings.some((w) => w.includes("Looks"))).toBe(true);
  });

  it("vault not configured returns friendly error", async () => {
    const result = await learnFromMyCorpusImpl(fakeCtx(), defaults());
    expect(result.isError).toBe(true);
  });

  it("malformed recipe JSON warns + keeps scanning", async () => {
    const dir = makeTmp();
    mkdirSync(join(dir, "Recipes"), { recursive: true });
    writeFileSync(join(dir, "Recipes/bad.json"), "{not json", "utf8");
    writeJson(dir, "Recipes/good.json", {
      id: "g",
      name: "g",
      nodes: [{ name: "n", type: "noiseTOP", parameters: {} }],
      connections: [],
    });
    const vault = new Vault(dir);
    const result = await learnFromMyCorpusImpl(fakeCtx(vault), defaults());
    const data = dataOf(result);
    const cs = data?.corpus_style as Record<string, unknown>;
    const warnings = cs.warnings as string[];
    expect(warnings.some((w) => w.includes("malformed recipe JSON"))).toBe(true);
    expect((cs.scanned as { recipes: number }).recipes).toBe(1);
  });

  it("vault_path override succeeds even when ctx has no vault", async () => {
    const { dir } = makeFixtureVault();
    const result = await learnFromMyCorpusImpl(fakeCtx(), defaults({ vault_path: dir }));
    expect(result.isError).not.toBe(true);
    const data = dataOf(result);
    expect(data?.wrote_note).toBe(true);
  });

  it("does not write to Memory/conventions.md", async () => {
    const { vault } = makeFixtureVault();
    await learnFromMyCorpusImpl(fakeCtx(vault), defaults());
    expect(vault.exists(memoryNoteRel("conventions"))).toBe(false);
  });
});
