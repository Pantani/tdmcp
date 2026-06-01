import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { tutorialCompanionPackImpl } from "../../src/tools/vault/tutorialCompanionPack.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const tmpDirs: string[] = [];
function makeVault(): Vault {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-tut-"));
  tmpDirs.push(dir);
  return new Vault(dir);
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeCtx(vault?: Vault): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
    vault,
  };
}

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function jsonOf(result: { content: unknown[] }) {
  const text = (result.content[0] as { text: string }).text;
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error(`no json: ${text}`);
  return JSON.parse(m[1]);
}

function mockTopology(nodes: Array<{ path: string; type: string; name: string }>) {
  server.use(
    http.get(`${TD_BASE}/api/network/:seg/topology`, () => ok({ nodes, connections: [] })),
  );
}

describe("tutorialCompanionPackImpl", () => {
  it("errors when no vault is configured", async () => {
    const result = await tutorialCompanionPackImpl(makeCtx(undefined), {
      source_comp: "/project1/scene",
      folder: "Tutorials",
      lesson_count: 3,
      preview_width: 128,
      preview_height: 72,
      tags: [],
    });
    expect(result.isError).toBe(true);
  });

  it("writes tutorial.md + topology.json + network_snapshot.json and captures a preview", async () => {
    const vault = makeVault();
    mockTopology([
      { path: "/project1/scene/noise1", type: "noiseTOP", name: "noise1" },
      { path: "/project1/scene/out1", type: "nullTOP", name: "out1" },
    ]);
    server.use(
      http.get(`${TD_BASE}/api/preview/:seg`, () =>
        ok({
          path: "/project1/scene/out1",
          width: 128,
          height: 72,
          base64: Buffer.from("fakepng").toString("base64"),
          mime_type: "image/png",
        }),
      ),
    );
    const result = await tutorialCompanionPackImpl(makeCtx(vault), {
      source_comp: "/project1/scene",
      folder: "Tutorials",
      lesson_count: 3,
      preview_width: 128,
      preview_height: 72,
      tags: ["beginner"],
    });
    expect(result.isError).toBeFalsy();
    const r = jsonOf(result);
    expect(r.node_count).toBe(2);
    expect(vault.exists(r.tutorial_path)).toBe(true);
    expect(vault.exists(r.topology_path)).toBe(true);
    expect(vault.exists(r.network_snapshot_path)).toBe(true);
    expect(r.network_snapshot_path.endsWith("network_snapshot.json")).toBe(true);
    expect(r.previews.length).toBeGreaterThan(0);
    const note = vault.readNote(r.tutorial_path);
    expect(note.data.type).toBe("tutorial");
    expect((note.data.tags as string[]).includes("beginner")).toBe(true);
    // The tutorial body should warn that the snapshot is not an installable recipe.
    expect(note.body).toContain("network_snapshot.json");
    expect(note.body).toContain("Not an installable recipe");
    // Snapshot file shape: tagged with kind="network_snapshot", not RecipeSchema.
    const snapshot = JSON.parse(vault.read(r.network_snapshot_path)) as {
      kind: string;
      nodes: Array<{ source_path: string }>;
    };
    expect(snapshot.kind).toBe("network_snapshot");
    expect(snapshot.nodes[0]?.source_path).toBe("/project1/scene/noise1");
  });

  it("surfaces a bridge failure as an error result", async () => {
    const vault = makeVault();
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    const result = await tutorialCompanionPackImpl(makeCtx(vault), {
      source_comp: "/project1/nope",
      folder: "Tutorials",
      lesson_count: 3,
      preview_width: 128,
      preview_height: 72,
      tags: [],
    });
    expect(result.isError).toBe(true);
  });

  it("rejects an escaping `folder` before issuing any TD topology call", async () => {
    const vault = makeVault();
    let topologyCalls = 0;
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => {
        topologyCalls += 1;
        return HttpResponse.json({ ok: true, value: { nodes: [], connections: [] } });
      }),
    );
    const result = await tutorialCompanionPackImpl(makeCtx(vault), {
      source_comp: "/project1/scene",
      folder: "../escape",
      lesson_count: 3,
      preview_width: 128,
      preview_height: 72,
      tags: [],
    });
    expect(result.isError).toBe(true);
    const txt = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(txt).toContain("Invalid vault folder");
    expect(topologyCalls).toBe(0);
  });
});
