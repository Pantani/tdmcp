import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import {
  CONVENTIONS_TOPIC,
  type ConventionsReport,
  type ConventionsRow,
  learnConventionsImpl,
  learnConventionsSchema,
} from "../../src/tools/vault/learnConventions.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { memoryNoteRel, STYLE_NOTE_REL } from "../../src/vault/memoryNote.js";

const SCOPE = "/project1";

function fakeCtx(exec: ReturnType<typeof vi.fn>, vault?: Vault): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
    ...(vault ? { vault } : {}),
  } as unknown as ToolContext;
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

const tmpDirs: string[] = [];
function makeVault(): Vault {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-learn-conv-"));
  tmpDirs.push(dir);
  return new Vault(dir);
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function row(p: Partial<ConventionsRow> & { path: string }): ConventionsRow {
  return p as ConventionsRow;
}

/**
 * Fixture topology — designed so:
 *  - naming: snake_case majority, TOP/fb prefix support=3, CHOP/audio=2 (below default support=3)
 *  - colors: 3 nodes share [0.2,0.4,0.8] feedbackTOP
 *  - container: one /project1/generator_a COMP with 4 generator-archetype children
 *  - layout: per parent nodeX strictly increasing → left-to-right
 *  - params: 5 feedbackTOP instances with opacity=0.94
 */
function happyReport(): ConventionsReport {
  const rows: ConventionsRow[] = [
    // 3 feedback TOPs (snake_case, fb prefix), all sharing color and opacity=0.94
    row({
      path: `${SCOPE}/fb_1`,
      name: "fb_1",
      type: "feedbackTOP",
      family: "TOP",
      parent_path: SCOPE,
      color: [0.2, 0.4, 0.8],
      nodeX: 0,
      nodeY: 0,
      builtin_pars: { opacity: 0.94 },
    }),
    row({
      path: `${SCOPE}/fb_2`,
      name: "fb_2",
      type: "feedbackTOP",
      family: "TOP",
      parent_path: SCOPE,
      color: [0.2, 0.4, 0.8],
      nodeX: 100,
      nodeY: 0,
      builtin_pars: { opacity: 0.94 },
    }),
    row({
      path: `${SCOPE}/fb_3`,
      name: "fb_3",
      type: "feedbackTOP",
      family: "TOP",
      parent_path: SCOPE,
      color: [0.2, 0.4, 0.8],
      nodeX: 200,
      nodeY: 0,
      builtin_pars: { opacity: 0.94 },
    }),
    // 2 more feedback TOPs (different color) to hit opacity support=5
    row({
      path: `${SCOPE}/fb_extra_1`,
      name: "fb_extra_1",
      type: "feedbackTOP",
      family: "TOP",
      parent_path: SCOPE,
      nodeX: 300,
      nodeY: 0,
      builtin_pars: { opacity: 0.94 },
    }),
    row({
      path: `${SCOPE}/fb_extra_2`,
      name: "fb_extra_2",
      type: "feedbackTOP",
      family: "TOP",
      parent_path: SCOPE,
      nodeX: 400,
      nodeY: 0,
      builtin_pars: { opacity: 0.94 },
    }),
    // 2 audio CHOPs (snake_case)
    row({
      path: `${SCOPE}/audio_in`,
      name: "audio_in",
      type: "audiodeviceinCHOP",
      family: "CHOP",
      parent_path: SCOPE,
      nodeX: 500,
      nodeY: 100,
    }),
    row({
      path: `${SCOPE}/audio_out`,
      name: "audio_out",
      type: "audiodeviceoutCHOP",
      family: "CHOP",
      parent_path: SCOPE,
      nodeX: 600,
      nodeY: 100,
    }),
    // Output, control (single instances)
    row({
      path: `${SCOPE}/output`,
      name: "output",
      type: "outTOP",
      family: "TOP",
      parent_path: SCOPE,
      nodeX: 700,
      nodeY: 0,
    }),
    row({
      path: `${SCOPE}/control`,
      name: "control",
      type: "containerCOMP",
      family: "COMP",
      parent_path: SCOPE,
      nodeX: 800,
      nodeY: 200,
    }),
    // Three depth-1 COMP children that look like generator archetype (3 clusters of same shape)
    row({
      path: `${SCOPE}/generator_a`,
      name: "generator_a",
      type: "baseCOMP",
      family: "COMP",
      parent_path: SCOPE,
      nodeX: 900,
      nodeY: 0,
    }),
    row({
      path: `${SCOPE}/generator_b`,
      name: "generator_b",
      type: "baseCOMP",
      family: "COMP",
      parent_path: SCOPE,
      nodeX: 1000,
      nodeY: 0,
    }),
    row({
      path: `${SCOPE}/generator_c`,
      name: "generator_c",
      type: "baseCOMP",
      family: "COMP",
      parent_path: SCOPE,
      nodeX: 1100,
      nodeY: 0,
    }),
  ];
  // 4 children each for the three generator COMPs (same dominant types → one cluster, count=3)
  for (const parent of ["generator_a", "generator_b", "generator_c"]) {
    rows.push(
      row({
        path: `${SCOPE}/${parent}/noise_1`,
        name: "noise_1",
        type: "noiseTOP",
        family: "TOP",
        parent_path: `${SCOPE}/${parent}`,
        nodeX: 0,
        nodeY: 0,
      }),
      row({
        path: `${SCOPE}/${parent}/fb_a`,
        name: "fb_a",
        type: "feedbackTOP",
        family: "TOP",
        parent_path: `${SCOPE}/${parent}`,
        nodeX: 100,
        nodeY: 0,
      }),
      row({
        path: `${SCOPE}/${parent}/level_1`,
        name: "level_1",
        type: "levelTOP",
        family: "TOP",
        parent_path: `${SCOPE}/${parent}`,
        nodeX: 200,
        nodeY: 0,
      }),
      row({
        path: `${SCOPE}/${parent}/out_1`,
        name: "out_1",
        type: "nullTOP",
        family: "TOP",
        parent_path: `${SCOPE}/${parent}`,
        nodeX: 300,
        nodeY: 0,
      }),
    );
  }
  return { scope_path: SCOPE, scanned: rows.length, rows, warnings: [] };
}

function execReturning(report: ConventionsReport): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout: JSON.stringify(report) }));
}

describe("learnConventionsImpl — schema", () => {
  it("applies sensible defaults", () => {
    const p = learnConventionsSchema.parse({});
    expect(p.scope_path).toBe("/project1");
    expect(p.observe).toEqual(["naming", "colors", "topology", "params"]);
    expect(p.max_nodes).toBe(500);
    expect(p.min_support).toBe(3);
    expect(p.dry_run).toBe(false);
    expect(p.also_patch_style_memory).toBe(true);
  });
});

describe("learnConventionsImpl — no vault", () => {
  it("returns a friendly error when TDMCP_VAULT_PATH is unset", async () => {
    const exec = vi.fn();
    const result = await learnConventionsImpl(fakeCtx(exec), learnConventionsSchema.parse({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
    // Should bail BEFORE invoking the bridge
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("learnConventionsImpl — happy path", () => {
  it("extracts naming, colors, topology, params, layout and writes the memory note", async () => {
    const vault = makeVault();
    const exec = execReturning(happyReport());
    const result = await learnConventionsImpl(
      fakeCtx(exec, vault),
      learnConventionsSchema.parse({}),
    );
    expect(result.isError).toBeFalsy();
    const data = dataOf(result) as
      | {
          note: string;
          wrote_note: boolean;
          wrote_style_memory: boolean;
          conventions: {
            naming: { case: string; prefixes_by_family: Record<string, Record<string, number>> };
            color_tags: Array<{ rgb: number[]; count: number }>;
            container_shapes: Array<{
              archetype: string;
              child_count_range: [number, number];
              count: number;
            }>;
            param_defaults: Array<{ type: string; param: string; value: unknown; support: number }>;
            layout: string;
          };
        }
      | undefined;
    expect(data).toBeDefined();
    if (!data) throw new Error("no data");
    const conv = data.conventions;
    expect(conv.naming.case).toBe("snake_case");
    expect(conv.naming.prefixes_by_family.TOP?.fb ?? 0).toBeGreaterThanOrEqual(3);
    expect(conv.color_tags[0]?.rgb).toEqual([0.2, 0.4, 0.8]);
    expect(conv.container_shapes[0]?.archetype).toBe("generator");
    const opacityEntry = conv.param_defaults.find(
      (p) => p.type === "feedbackTOP" && p.param === "opacity",
    );
    expect(opacityEntry).toBeDefined();
    expect(opacityEntry?.value).toBe(0.94);
    expect(opacityEntry?.support).toBe(5);
    expect(conv.layout).toBe("left-to-right");
    expect(data?.wrote_note).toBe(true);
    expect(data?.wrote_style_memory).toBe(true);

    // Vault really got the note + style memory.
    const noteRel = memoryNoteRel(CONVENTIONS_TOPIC);
    expect(vault.exists(noteRel)).toBe(true);
    const note = vault.readNote(noteRel);
    expect(note.data.type).toBe("tdmcp-memory");
    expect(note.data.topic).toBe("conventions");
    expect(note.body).toContain("Conventions learned");

    expect(vault.exists(STYLE_NOTE_REL)).toBe(true);
    const styleNote = vault.readNote(STYLE_NOTE_REL);
    expect(styleNote.data.naming).toBe("snake_case");
    expect(styleNote.data.layout).toBe("left-to-right");
  });

  it("dry_run: extracts but does NOT write any vault file", async () => {
    const vault = makeVault();
    const exec = execReturning(happyReport());
    const result = await learnConventionsImpl(
      fakeCtx(exec, vault),
      learnConventionsSchema.parse({ dry_run: true }),
    );
    expect(result.isError).toBeFalsy();
    const data = dataOf(result) as { wrote_note: boolean; wrote_style_memory: boolean };
    expect(data.wrote_note).toBe(false);
    expect(data.wrote_style_memory).toBe(false);
    expect(vault.exists(memoryNoteRel(CONVENTIONS_TOPIC))).toBe(false);
    expect(vault.exists(STYLE_NOTE_REL)).toBe(false);
  });

  it("observe:['naming'] trims the other sections out of the result", async () => {
    const vault = makeVault();
    const exec = execReturning(happyReport());
    const result = await learnConventionsImpl(
      fakeCtx(exec, vault),
      learnConventionsSchema.parse({ observe: ["naming"] }),
    );
    const data = dataOf(result) as { conventions: Record<string, unknown> };
    expect(data.conventions.naming).toBeDefined();
    expect(data.conventions.color_tags).toBeUndefined();
    expect(data.conventions.container_shapes).toBeUndefined();
    expect(data.conventions.param_defaults).toBeUndefined();
  });

  it("min_support=10 yields no patterns (everything below threshold)", async () => {
    const vault = makeVault();
    const exec = execReturning(happyReport());
    const result = await learnConventionsImpl(
      fakeCtx(exec, vault),
      learnConventionsSchema.parse({ min_support: 10 }),
    );
    const data = dataOf(result) as {
      conventions: {
        naming: { prefixes_by_family: Record<string, unknown> };
        color_tags: unknown[];
        container_shapes: unknown[];
        param_defaults: unknown[];
      };
    };
    expect(Object.keys(data.conventions.naming.prefixes_by_family)).toHaveLength(0);
    expect(data.conventions.color_tags).toEqual([]);
    expect(data.conventions.container_shapes).toEqual([]);
    expect(data.conventions.param_defaults).toEqual([]);
  });

  it("also_patch_style_memory:false skips the style note", async () => {
    const vault = makeVault();
    const exec = execReturning(happyReport());
    await learnConventionsImpl(
      fakeCtx(exec, vault),
      learnConventionsSchema.parse({ also_patch_style_memory: false }),
    );
    expect(vault.exists(memoryNoteRel(CONVENTIONS_TOPIC))).toBe(true);
    expect(vault.exists(STYLE_NOTE_REL)).toBe(false);
  });
});

describe("learnConventionsImpl — bridge errors", () => {
  it("propagates a fatal field as an isError result and does NOT write the note", async () => {
    const vault = makeVault();
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        scope_path: SCOPE,
        scanned: 0,
        rows: [],
        warnings: [],
        fatal: "Scope COMP not found: /project1/missing",
      }),
    }));
    const result = await learnConventionsImpl(
      fakeCtx(exec, vault),
      learnConventionsSchema.parse({ scope_path: "/project1/missing" }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Scope COMP not found");
    expect(vault.exists(memoryNoteRel(CONVENTIONS_TOPIC))).toBe(false);
  });

  it("returns isError when the bridge throws (TD offline), no vault write", async () => {
    const vault = makeVault();
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await learnConventionsImpl(
      fakeCtx(exec, vault),
      learnConventionsSchema.parse({}),
    );
    expect(result.isError).toBe(true);
    expect(vault.exists(memoryNoteRel(CONVENTIONS_TOPIC))).toBe(false);
  });
});

describe("learnConventions Python script", () => {
  it("embeds the payload as base64 and ends with print(result)", async () => {
    const exec = execReturning(happyReport());
    const vault = makeVault();
    await learnConventionsImpl(fakeCtx(exec, vault), learnConventionsSchema.parse({}));
    const script = exec.mock.calls[0]?.[0] as string;
    expect(typeof script).toBe("string");
    expect(script).toContain("import json, base64");
    expect(script).toContain("result = json.dumps(report)");
    expect(script).toContain("print(result)");
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      scope_path: string;
      max_nodes: number;
    };
    expect(decoded.scope_path).toBe("/project1");
    expect(decoded.max_nodes).toBe(500);
  });
});
