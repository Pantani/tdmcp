import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { DocSiteReport } from "../../src/tools/layer3/projectDocumentationSite.js";
import {
  buildDocSiteScript,
  buildTopologyMd,
  pickOutputTops,
  projectDocumentationSiteImpl,
  projectDocumentationSiteSchema,
} from "../../src/tools/layer3/projectDocumentationSite.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Shared MSW server
// ---------------------------------------------------------------------------
const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

// ---------------------------------------------------------------------------
// Per-test temp dir, cleaned up afterwards.
// ---------------------------------------------------------------------------
let tmp: string;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});
function freshDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "tdmcp-docsite-"));
  return tmp;
}

// ---------------------------------------------------------------------------
// A fake topology: 3 nodes + 2 connections.
// ---------------------------------------------------------------------------
function makeReport(overrides: Partial<DocSiteReport> = {}): DocSiteReport {
  return {
    nodes: [
      { path: "/project1/noise1", type: "noiseTOP", name: "noise1" },
      { path: "/project1/blur1", type: "blurTOP", name: "blur1" },
      { path: "/project1/out1", type: "nullTOP", name: "out1" },
    ],
    connections: [
      { source_path: "/project1/noise1", target_path: "/project1/blur1" },
      { source_path: "/project1/blur1", target_path: "/project1/out1" },
    ],
    warnings: [],
    ...overrides,
  };
}

function overrideExec(stdout: string): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout } }),
    ),
  );
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Pure composer tests (no network)
// ---------------------------------------------------------------------------
describe("buildTopologyMd (pure)", () => {
  it("emits a deterministic Mermaid graph LR with exact edges", () => {
    const md = buildTopologyMd(makeReport(), "MyProj");
    expect(md).toContain("```mermaid");
    expect(md).toContain("graph LR");
    // Nodes are indexed in order: noise1=n0, blur1=n1, out1=n2.
    expect(md).toContain('n0["noise1 (noiseTOP)"]');
    expect(md).toContain('n1["blur1 (blurTOP)"]');
    expect(md).toContain('n2["out1 (nullTOP)"]');
    // Exact edges from the 2 connections.
    expect(md).toContain("n0 --> n1");
    expect(md).toContain("n1 --> n2");
  });
});

describe("pickOutputTops (pure)", () => {
  it("prefers out*/null* TOPs and caps at max", () => {
    const picked = pickOutputTops(makeReport().nodes, 6);
    // out1 (nullTOP) is preferred first, then the remaining TOPs.
    expect(picked.map((n) => n.name)).toEqual(["out1", "noise1", "blur1"]);
  });

  it("returns nothing when max is 0", () => {
    expect(pickOutputTops(makeReport().nodes, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Payload encoding
// ---------------------------------------------------------------------------
describe("buildDocSiteScript", () => {
  it("encodes parent_path into the base64 payload", () => {
    const script = buildDocSiteScript({ parent_path: "/project1/myComp" });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
    if (b64 === undefined) throw new Error("no base64 payload in script");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as {
      parent_path: string;
    };
    expect(payload.parent_path).toBe("/project1/myComp");
  });
});

// ---------------------------------------------------------------------------
// Handler integration (mocked bridge)
// ---------------------------------------------------------------------------
describe("projectDocumentationSiteImpl", () => {
  it("writes README.md and topology.md into out_dir with node count + Mermaid", async () => {
    overrideExec(JSON.stringify(makeReport()));
    const dir = freshDir();

    const result = await projectDocumentationSiteImpl(makeCtx(), {
      parent_path: "/project1",
      out_dir: dir,
      title: "",
      include_thumbnails: false,
      max_thumbnails: 6,
    });

    expect(result.isError).toBeFalsy();

    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("# project1");
    expect(readme).toContain("**Nodes:** 3");
    expect(readme).toContain("**Connections:** 2");

    const topo = readFileSync(join(dir, "topology.md"), "utf8");
    expect(topo).toContain("graph LR");
    expect(topo).toContain("n0 --> n1");
    expect(topo).toContain("n1 --> n2");
  });

  it("uses the explicit title when provided", async () => {
    overrideExec(JSON.stringify(makeReport()));
    const dir = freshDir();

    await projectDocumentationSiteImpl(makeCtx(), {
      parent_path: "/project1",
      out_dir: dir,
      title: "Portfolio Piece",
      include_thumbnails: false,
      max_thumbnails: 6,
    });

    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("# Portfolio Piece");
  });

  it("does NOT capture previews or write thumbs when include_thumbnails is false", async () => {
    let previewHit = false;
    server.use(
      http.get(`${TD_BASE}/api/preview/:seg`, () => {
        previewHit = true;
        return HttpResponse.json({ ok: false, error: { message: "should not be called" } });
      }),
    );
    overrideExec(JSON.stringify(makeReport()));
    const dir = freshDir();

    const result = await projectDocumentationSiteImpl(makeCtx(), {
      parent_path: "/project1",
      out_dir: dir,
      title: "",
      include_thumbnails: false,
      max_thumbnails: 6,
    });

    expect(result.isError).toBeFalsy();
    expect(previewHit).toBe(false);
    expect(existsSync(join(dir, "thumbs"))).toBe(false);
    expect(existsSync(join(dir, "gallery.md"))).toBe(false);
    const sc = (result as { content: Array<{ type: string; text?: string }> }).content;
    const text = sc.map((c) => c.text ?? "").join("\n");
    expect(text).toContain('"thumbnails": []');
  });

  it("captures previews and writes a gallery when include_thumbnails is true", async () => {
    // Default /api/preview/:seg mock returns a 1x1 PNG base64.
    overrideExec(JSON.stringify(makeReport()));
    const dir = freshDir();

    const result = await projectDocumentationSiteImpl(makeCtx(), {
      parent_path: "/project1",
      out_dir: dir,
      title: "",
      include_thumbnails: true,
      max_thumbnails: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, "thumbs"))).toBe(true);
    expect(existsSync(join(dir, "gallery.md"))).toBe(true);
    // max_thumbnails=2 ? out1 + noise1 (preferred order), capped at 2.
    expect(existsSync(join(dir, "thumbs", "out1.png"))).toBe(true);
    expect(existsSync(join(dir, "thumbs", "noise1.png"))).toBe(true);
    expect(existsSync(join(dir, "thumbs", "blur1.png"))).toBe(false);
    expect(readFileSync(join(dir, "gallery.md"), "utf8")).toContain("![out1](out1.png)");
  });

  it("returns an isError result when the Python report carries a fatal field", async () => {
    overrideExec(
      JSON.stringify({
        nodes: [],
        connections: [],
        warnings: [],
        fatal: "Network not found: /project1/ghost",
      }),
    );
    const dir = freshDir();

    const result = await projectDocumentationSiteImpl(makeCtx(), {
      parent_path: "/project1/ghost",
      out_dir: dir,
      title: "",
      include_thumbnails: false,
      max_thumbnails: 6,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Network not found");
    // Nothing should have been written.
    expect(existsSync(join(dir, "README.md"))).toBe(false);
  });

  it("does NOT throw when the bridge is offline - returns an isError result", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const dir = freshDir();

    const result = await projectDocumentationSiteImpl(makeCtx(), {
      parent_path: "/project1",
      out_dir: dir,
      title: "",
      include_thumbnails: false,
      max_thumbnails: 6,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
  });

  it("applies schema defaults", () => {
    const parsed = projectDocumentationSiteSchema.parse({ out_dir: "/tmp/x" });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.title).toBe("");
    expect(parsed.include_thumbnails).toBe(false);
    expect(parsed.max_thumbnails).toBe(6);
  });

  it("requires out_dir (schema rejects when missing)", () => {
    expect(() => projectDocumentationSiteSchema.parse({})).toThrow();
  });
});
