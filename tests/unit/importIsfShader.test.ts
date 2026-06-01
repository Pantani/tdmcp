import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  applyControlDefaults,
  extractIsfHeader,
  importIsfShaderImpl,
} from "../../src/tools/layer1/importIsfShader.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ctx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const baseArgs = {
  parent_path: "/project1",
  source_kind: "raw" as const,
  resolution: [640, 360] as [number, number],
  pixel_format: "rgba8" as const,
  channel_overrides: [],
  control_defaults: {},
  expose_controls: true,
  capture_preview: false,
  fetch_timeout_ms: 8000,
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ISF_MINIMAL = `/*{
  "DESCRIPTION": "Pass",
  "CREDIT": "test",
  "INPUTS": []
}*/
void main() { gl_FragColor = vec4(1.0); }`;

const ISF_WITH_COMMENTS = `// MIT License
// (c) someone 2024
/*{
  "DESCRIPTION": "Halftone",
  "CREDIT": "VIDVOX",
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "angle", "TYPE": "float", "DEFAULT": 0.5, "MIN": 0.0, "MAX": 1.0 },
    { "NAME": "tint", "TYPE": "color", "DEFAULT": [1,0.5,0.2,1] },
    { "NAME": "mode", "TYPE": "long", "VALUES": [0,1,2], "LABELS": ["A","B","C"], "DEFAULT": 1 },
    { "NAME": "center", "TYPE": "point2D", "DEFAULT": [0.5,0.5] },
    { "NAME": "flash",  "TYPE": "event" }
  ]
}*/
void main() { vec4 c = IMG_THIS_PIXEL(inputImage); gl_FragColor = c * tint; }`;

const ISF_BAD_JSON = `/*{ "DESCRIPTION": "broken", "INPUTS": [ }*/ void main(){}`;
const ISF_NO_HEADER = `void main() { gl_FragColor = vec4(0.0); }`;
const ISF_BRACES_IN_STRING = `/*{ "DESCRIPTION": "has } in string", "INPUTS": [] }*/ void main(){}`;
const ISF_BOM = `﻿${ISF_MINIMAL}`;
const ISF_CRLF = ISF_MINIMAL.replace(/\n/g, "\r\n");
const ISF_MULTIPASS = `/*{
  "DESCRIPTION": "Multi",
  "CREDIT": "test",
  "INPUTS": [],
  "PASSES": [{}, {}]
}*/
void main() { gl_FragColor = vec4(0.0); }`;

// ─── Header parser ───────────────────────────────────────────────────────────

describe("extractIsfHeader", () => {
  it("parses a minimal header and returns body starting with main", () => {
    const r = extractIsfHeader(ISF_MINIMAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.header.DESCRIPTION).toBe("Pass");
    expect(r.body.trimStart().startsWith("void main()")).toBe(true);
  });

  it("parses a header preceded by line comments and INPUTS of length 6", () => {
    const r = extractIsfHeader(ISF_WITH_COMMENTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.header.INPUTS?.length).toBe(6);
  });

  it("returns error for malformed JSON", () => {
    const r = extractIsfHeader(ISF_BAD_JSON);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/parse failed/i);
  });

  it("returns error when no /*{ block is present", () => {
    const r = extractIsfHeader(ISF_NO_HEADER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/\/\*\{/);
  });

  it("handles braces inside JSON strings via string-aware scanner", () => {
    const r = extractIsfHeader(ISF_BRACES_IN_STRING);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.header.DESCRIPTION).toBe("has } in string");
  });

  it("strips a leading UTF-8 BOM", () => {
    const r = extractIsfHeader(ISF_BOM);
    expect(r.ok).toBe(true);
  });

  it("tolerates CRLF line endings", () => {
    const r = extractIsfHeader(ISF_CRLF);
    expect(r.ok).toBe(true);
  });
});

// ─── Control-default merging ────────────────────────────────────────────────

describe("applyControlDefaults", () => {
  it("overrides matching defaults and warns on unknown / type-mismatched keys", () => {
    const parsed = extractIsfHeader(ISF_WITH_COMMENTS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const inputs = parsed.header.INPUTS ?? [];
    const r = applyControlDefaults(inputs, {
      angle: 0.9,
      tint: [0, 0, 0, 1],
      bogus: 1,
    });
    const angle = r.inputs.find((i) => i.NAME === "angle");
    const tint = r.inputs.find((i) => i.NAME === "tint");
    expect(angle?.DEFAULT).toBe(0.9);
    expect(tint?.DEFAULT).toEqual([0, 0, 0, 1]);
    expect(r.warnings.some((w) => /bogus/.test(w))).toBe(true);

    const typeMis = applyControlDefaults(inputs, { angle: "wat" });
    const angleUnchanged = typeMis.inputs.find((i) => i.NAME === "angle");
    expect(angleUnchanged?.DEFAULT).toBe(0.5);
    expect(typeMis.warnings.some((w) => /angle/.test(w))).toBe(true);
  });
});

// ─── End-to-end (raw) ────────────────────────────────────────────────────────

interface MswCtx {
  createdTypes: string[];
  connects: Array<{ from: string; to: string }>;
  execScripts: string[];
}

function captureBuildHandlers(): MswCtx {
  const captured: MswCtx = { createdTypes: [], connects: [], execScripts: [] };
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as {
        parent_path: string;
        type: string;
        name?: string;
      };
      captured.createdTypes.push(body.type);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      captured.execScripts.push(body.script);
      // exposeControls parses parsePythonReport(stdout) → must return JSON-looking output
      // Provide a generic stdout that satisfies the parser when called with returnsValue.
      return HttpResponse.json({
        ok: true,
        data: {
          result: null,
          stdout: '{"created": [], "bound": [], "warnings": []}',
        },
      });
    }),
  );
  return captured;
}

describe("importIsfShaderImpl (end-to-end via msw)", () => {
  it("builds the network and surfaces provenance from the ISF header", async () => {
    const cap = captureBuildHandlers();
    const result = await importIsfShaderImpl(ctx(), {
      ...baseArgs,
      source: ISF_WITH_COMMENTS,
    });
    expect(result.isError).toBeFalsy();
    expect(cap.createdTypes).toContain("glslTOP");
    expect(cap.createdTypes).toContain("textDAT");
    expect(cap.createdTypes).toContain("nullTOP");
    expect(cap.createdTypes).toContain("noiseTOP"); // image input placeholder
    const text = textOf(result);
    expect(text).toMatch(/Halftone/);
    expect(text).toMatch(/VIDVOX/);
  });

  it("returns isError without creating nodes when JSON is malformed", async () => {
    const cap = captureBuildHandlers();
    const result = await importIsfShaderImpl(ctx(), {
      ...baseArgs,
      source: ISF_BAD_JSON,
    });
    expect(result.isError).toBe(true);
    expect(cap.createdTypes).toEqual([]);
  });

  it("wires a user-supplied channel_overrides source_path instead of a placeholder", async () => {
    const cap = captureBuildHandlers();
    const result = await importIsfShaderImpl(ctx(), {
      ...baseArgs,
      source: ISF_WITH_COMMENTS,
      channel_overrides: [{ index: 0, source_path: "/project1/movie1" }],
    });
    expect(result.isError).toBeFalsy();
    // No placeholder noiseTOP created for ichan0 when an override is supplied.
    expect(cap.createdTypes.filter((t) => t === "noiseTOP")).toEqual([]);
  });

  it("succeeds when source_kind is url and msw stubs a 200; surfaces error on 404", async () => {
    captureBuildHandlers();
    server.use(
      http.get("https://example.test/ok.fs", () => HttpResponse.text(ISF_MINIMAL, { status: 200 })),
      http.get("https://example.test/missing.fs", () => HttpResponse.text("nope", { status: 404 })),
    );
    const ok = await importIsfShaderImpl(ctx(), {
      ...baseArgs,
      source_kind: "url",
      source: "https://example.test/ok.fs",
    });
    expect(ok.isError).toBeFalsy();

    const fail = await importIsfShaderImpl(ctx(), {
      ...baseArgs,
      source_kind: "url",
      source: "https://example.test/missing.fs",
    });
    expect(fail.isError).toBe(true);
    expect(textOf(fail)).toMatch(/404|Failed to resolve/i);
  });

  it("emits the multi-pass deferred warning when PASSES has length > 1", async () => {
    captureBuildHandlers();
    const result = await importIsfShaderImpl(ctx(), {
      ...baseArgs,
      source: ISF_MULTIPASS,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/Multi-pass/);
  });
});
