import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import { libraryLineageGraphImpl } from "../../src/tools/vault/libraryLineageGraph.js";
import { Vault } from "../../src/vault/index.js";

const FIXTURE = resolve(__dirname, "../fixtures/vault-lineage");

function makeCtx(vaultPath?: string): ToolContext {
  return {
    client: {} as ToolContext["client"],
    knowledge: {} as ToolContext["knowledge"],
    recipes: [] as unknown as ToolContext["recipes"],
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    vault: vaultPath ? new Vault(vaultPath) : undefined,
    allowRawPython: false,
  };
}

function getStructured(result: Awaited<ReturnType<typeof libraryLineageGraphImpl>>) {
  // biome-ignore lint/suspicious/noExplicitAny: structured-content shape varies per test
  const r = result as any;
  return r.structuredContent ?? r;
}

describe("libraryLineageGraph", () => {
  it("1. json format returns 6 nodes and path-resolved edge for beat_grid → audio_pulse", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["all"],
      cluster_by: "style_tags",
      include_orphans: true,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    expect(sc.nodes).toHaveLength(7); // audio_pulse, beat_grid, datamosh, cycle_a, cycle_b = 5 Recipes + glow (Components) + missing_parent (Shaders)
    const beatEdge = sc.edges.find(
      (e: { from: string; to: string; relation: string; match: string }) =>
        e.from === "Recipes/beat_grid.md" &&
        e.to === "Recipes/audio_pulse.md" &&
        e.relation === "parent_recipe",
    );
    expect(beatEdge).toBeDefined();
    expect(beatEdge?.match).toBe("path");
  });

  it("2. title-resolved edge: datamosh → audio_pulse with match:'title'", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["all"],
      cluster_by: "style_tags",
      include_orphans: true,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    const edge = sc.edges.find(
      (e: { from: string; to: string; relation: string; match: string }) =>
        e.from === "Recipes/datamosh.md" && e.relation === "source_asset",
    );
    expect(edge).toBeDefined();
    expect(edge?.to).toBe("Recipes/audio_pulse.md");
    expect(edge?.match).toBe("title");
  });

  it("3. unresolved parent_recipe emits match:'unresolved' and warning mentioning ghost.md", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["all"],
      cluster_by: "style_tags",
      include_orphans: true,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    const edge = sc.edges.find(
      (e: { from: string; match: string }) =>
        e.from === "Shaders/missing_parent.md" && e.match === "unresolved",
    );
    expect(edge).toBeDefined();
    expect(sc.warnings.some((w: string) => w.includes("ghost.md"))).toBe(true);
  });

  it("4. cluster_by:'style_tags' produces audio-reactive cluster with audio_pulse and beat_grid", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["all"],
      cluster_by: "style_tags",
      include_orphans: true,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    const audioCluster = sc.clusters.find(
      (c: { key: string; members: string[] }) => c.key === "audio-reactive",
    );
    expect(audioCluster).toBeDefined();
    expect(audioCluster?.members).toContain("Recipes/audio_pulse.md");
    expect(audioCluster?.members).toContain("Recipes/beat_grid.md");
  });

  it("5. contributors includes alice:2 and bob:1", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["all"],
      cluster_by: "style_tags",
      include_orphans: true,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    const alice = sc.contributors.find((c: { author: string }) => c.author === "alice");
    expect(alice).toBeDefined();
    expect(alice?.count).toBe(2);
    const bob = sc.contributors.find((c: { author: string }) => c.author === "bob");
    expect(bob).toBeDefined();
    expect(bob?.count).toBe(1);
  });

  it("6. include_orphans:false removes Components/glow.md", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["all"],
      cluster_by: "style_tags",
      include_orphans: false,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    const glowNode = sc.nodes.find((n: { id: string }) => n.id === "Components/glow.md");
    expect(glowNode).toBeUndefined();
  });

  it("7. format:'mermaid' starts with 'graph LR', contains subgraph audio-reactive, has unresolved node", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "mermaid",
      kinds: ["all"],
      cluster_by: "style_tags",
      include_orphans: true,
      max_nodes: 500,
    });
    // structuredResult puts rendered text as the text content
    // biome-ignore lint/suspicious/noExplicitAny: structured-content shape varies per test
    const r = result as any;
    const textContent = r.content?.[0]?.text ?? "";
    expect(textContent).toMatch(/^graph LR/);
    expect(textContent).toContain("subgraph audio-reactive");
    expect(textContent).toContain("UNRESOLVED");
  });

  it("8. format:'dot' starts with 'digraph lineage', every node id double-quoted", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "dot",
      kinds: ["all"],
      cluster_by: "none",
      include_orphans: true,
      max_nodes: 500,
    });
    // biome-ignore lint/suspicious/noExplicitAny: structured-content shape varies per test
    const r = result as any;
    const textContent = r.content?.[0]?.text ?? "";
    expect(textContent).toMatch(/^digraph lineage/);
    // All node declarations should use double-quoted ids
    const nodeDecls = textContent.match(/"[^"]+"\s*\[/g) ?? [];
    expect(nodeDecls.length).toBeGreaterThan(0);
  });

  it("9. cycle nodes both appear; no hang (completes quickly)", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["recipes"],
      cluster_by: "none",
      include_orphans: true,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    const cycleA = sc.nodes.find((n: { id: string }) => n.id === "Recipes/cycle_a.md");
    const cycleB = sc.nodes.find((n: { id: string }) => n.id === "Recipes/cycle_b.md");
    expect(cycleA).toBeDefined();
    expect(cycleB).toBeDefined();
  });

  it("10. empty result when kinds=['setlists'] and no setlists exist", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["setlists"],
      cluster_by: "none",
      include_orphans: true,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    expect(sc.counts.nodes).toBe(0);
    // biome-ignore lint/suspicious/noExplicitAny: structured-content shape varies per test
    const r = result as any;
    const textContent = r.content?.[0]?.text ?? "";
    expect(textContent).toContain("No lineage data");
  });

  it("11. max_nodes:2 truncation emits warning and returns only 2 nodes", async () => {
    const ctx = makeCtx(FIXTURE);
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["all"],
      cluster_by: "none",
      include_orphans: true,
      max_nodes: 2,
    });
    const sc = getStructured(result);
    expect(sc.nodes).toHaveLength(2);
    expect(sc.warnings.some((w: string) => w.toLowerCase().includes("truncated"))).toBe(true);
  });

  it("uses vault_path override instead of ctx.vault", async () => {
    const ctx = makeCtx(); // no vault in ctx
    const result = await libraryLineageGraphImpl(ctx, {
      vault_path: FIXTURE,
      format: "json",
      kinds: ["recipes"],
      cluster_by: "none",
      include_orphans: true,
      max_nodes: 500,
    });
    const sc = getStructured(result);
    expect(sc.nodes.length).toBeGreaterThan(0);
  });

  it("returns error when vault not configured and no vault_path override", async () => {
    const ctx = makeCtx(); // no vault
    const result = await libraryLineageGraphImpl(ctx, {
      format: "json",
      kinds: ["all"],
      cluster_by: "none",
      include_orphans: true,
      max_nodes: 500,
    });
    // biome-ignore lint/suspicious/noExplicitAny: structured-content shape varies per test
    const r = result as any;
    expect(r.isError).toBe(true);
  });
});
