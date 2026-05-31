import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const SNAKE_RE = /^[a-z][a-z0-9_]*$/;

const RESERVED_NAMES = new Set([
  "get_td_info",
  "execute_python_script",
  "exec_node_method",
  "find_td_nodes",
  "get_td_nodes",
  "get_td_node_parameters",
  "scaffold_tool_generator",
]);

export const scaffoldToolGeneratorSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      SNAKE_RE,
      "name must be snake_case: lowercase letters, digits, underscores; start with a letter",
    )
    .describe("snake_case tool name, e.g. 'create_smoke_field'"),
  layer: z
    .enum(["layer1", "layer2", "layer3", "library", "vault"])
    .default("layer2")
    .describe("Destination layer directory under src/tools/"),
  surface: z
    .enum(["bridge", "layer1_build", "prompt", "local_only"])
    .default("bridge")
    .describe("Scaffold template variant"),
  description: z.string().min(1).describe("One-line MCP tool description"),
  repo_root: z
    .string()
    .optional()
    .describe("Repo root (default: process.cwd()); for tests use a tmpdir"),
  overwrite: z.boolean().default(false).describe("Overwrite existing file if true"),
});

type ScaffoldToolGeneratorArgs = z.infer<typeof scaffoldToolGeneratorSchema>;

// ---- name conversions ----

function toCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function toPascal(snake: string): string {
  const c = toCamel(snake);
  return (c[0] ?? "").toUpperCase() + c.slice(1);
}

function toKebab(snake: string): string {
  return snake.replace(/_/g, "-");
}

function layerToDir(layer: string): string {
  if (layer === "library") return "library";
  if (layer === "vault") return "vault";
  return layer; // "layer1", "layer2", "layer3"
}

// ---- templates ----

function templateA(snake: string, pascal: string, camel: string, desc: string): string {
  const descEsc = JSON.stringify(desc);
  return `import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const ${camel}Schema = z.object({
  // TODO: real inputs
  target_path: z.string().min(1).describe("Path of the target node."),
});
type ${pascal}Args = z.infer<typeof ${camel}Schema>;

interface ${pascal}Report {
  ok: boolean;
  warnings: string[];
  fatal?: string;
}

const ${pascal.toUpperCase()}_SCRIPT = \`
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"ok": False, "warnings": []}
try:
    _t = op(_p["target_path"])
    if _t is None:
        report["fatal"] = "Not found: " + str(_p["target_path"])
    else:
        # TODO: real work
        report["ok"] = True
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
\`;

export async function ${camel}Impl(ctx: ToolContext, args: ${pascal}Args) {
  const script = buildPayloadScript(${pascal.toUpperCase()}_SCRIPT, { target_path: args.target_path });
  return guardTd(
    () => ctx.client.executePythonScript(script, true),
    (exec) => {
      const report = parsePythonReport<${pascal}Report>(exec.stdout);
      if (report.fatal) return errorResult(report.fatal, report);
      return jsonResult(\`${snake}: ok\`, report);
    },
  );
}

export const register${pascal}: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "${snake}",
    {
      title: "${pascal}",
      description: ${descEsc},
      inputSchema: ${camel}Schema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => ${camel}Impl(ctx, args),
  );
};
`;
}

function templateB(snake: string, pascal: string, camel: string, desc: string): string {
  const descEsc = JSON.stringify(desc);
  return `import { z } from "zod";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// UNVERIFIED — confirm orchestration.ts signature matches template at PR time.

export const ${camel}Schema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP path."),
  // TODO: real inputs
});
type ${pascal}Args = z.infer<typeof ${camel}Schema>;

export async function ${camel}Impl(ctx: ToolContext, args: ${pascal}Args) {
  return runBuild(async () => {
    const { builder, container } = await createSystemContainer(ctx, args.parent_path, "${snake}");
    // TODO: add nodes via builder
    void container;
    return finalize(ctx, {
      summary: "${snake} created",
      builder,
      outputPath: container.path,
      controls: [],
      extra: {},
    });
  });
}

export const register${pascal}: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "${snake}",
    {
      title: "${pascal}",
      description: ${descEsc},
      inputSchema: ${camel}Schema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => ${camel}Impl(ctx, args),
  );
};
`;
}

function templateC(snake: string, pascal: string, camel: string, desc: string): string {
  const descEsc = JSON.stringify(desc);
  return `import { z } from "zod";
import { promises as fs } from "node:fs";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const ${camel}Schema = z.object({
  // TODO: real inputs
  target_path: z.string().min(1).describe("Target path."),
});
type ${pascal}Args = z.infer<typeof ${camel}Schema>;

export async function ${camel}Impl(_ctx: ToolContext, args: ${pascal}Args) {
  try {
    // TODO: real filesystem/DX work
    return structuredResult("${snake}: ok", { path: args.target_path });
  } catch (err) {
    return errorResult(\`${snake} failed: \${err instanceof Error ? err.message : String(err)}\`);
  }
}

export const register${pascal}: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "${snake}",
    {
      title: "${pascal}",
      description: ${descEsc},
      inputSchema: ${camel}Schema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => ${camel}Impl(ctx, args),
  );
};
`;
}

function templateD(snake: string, _camel: string, desc: string): string {
  const descEsc = JSON.stringify(desc);
  return `// UNVERIFIED — read src/prompts/index.ts pattern before using this stub.
export const name = "${snake}";
export const description = ${descEsc};

// TODO: implement prompt content
export const register = (_server: unknown) => {
  // Register prompt with server
};
`;
}

function templateTest(
  _snake: string,
  _pascal: string,
  camel: string,
  surface: string,
  layer: string,
): string {
  const layerDir = layerToDir(layer);
  if (surface === "bridge") {
    return `import { describe, expect, it, vi } from "vitest";
import { ${camel}Impl, ${camel}Schema } from "../../src/tools/${layerDir}/${camel}.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

describe("${camel}", () => {
  it("happy path returns ok", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true, warnings: [] }),
    }));
    const ctx = fakeCtx(exec);
    const args = ${camel}Schema.parse({ target_path: "/project1/test" });
    const result = await ${camel}Impl(ctx, args);
    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("fatal path returns isError without throwing", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: false, warnings: [], fatal: "boom" }),
    }));
    const ctx = fakeCtx(exec);
    const args = ${camel}Schema.parse({ target_path: "/project1/test" });
    await expect(${camel}Impl(ctx, args)).resolves.toMatchObject({ isError: true });
  });

  it("schema rejects missing required fields", () => {
    expect(() => ${camel}Schema.parse({})).toThrow();
  });
});
`;
  }

  if (surface === "local_only" || surface === "prompt") {
    return `import { describe, expect, it } from "vitest";
import { ${camel}Impl, ${camel}Schema } from "../../src/tools/${layerDir}/${camel}.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const ctx = { logger: silentLogger } as unknown as ToolContext;

describe("${camel}", () => {
  it("happy path returns structured result", async () => {
    const args = ${camel}Schema.parse({ target_path: "/some/path" });
    const result = await ${camel}Impl(ctx, args);
    expect(result.isError).toBeFalsy();
  });

  it("schema rejects missing required fields", () => {
    expect(() => ${camel}Schema.parse({})).toThrow();
  });
});
`;
  }

  // layer1_build
  return `import { describe, expect, it, vi } from "vitest";
import { ${camel}Impl, ${camel}Schema } from "../../src/tools/${layerDir}/${camel}.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const ctx = { logger: silentLogger } as unknown as ToolContext;

describe("${camel}", () => {
  it("schema accepts valid args", () => {
    const args = ${camel}Schema.parse({});
    expect(args.parent_path).toBe("/project1");
  });
});
`;
}

// ---- main impl ----

export interface ScaffoldReport {
  files: Array<{ path: string; bytes: number; created: boolean }>;
  integration_hint: {
    registrar_import: string;
    registrar_array_entry: string;
    layer_index_path: string;
    cli_command_name: string;
    cli_command_args_hint: string;
  };
  warnings: string[];
}

export async function scaffoldToolGeneratorImpl(
  _ctx: ToolContext,
  args: ScaffoldToolGeneratorArgs,
): Promise<ReturnType<typeof structuredResult | typeof errorResult>> {
  // Pre-flight: reserved name
  if (RESERVED_NAMES.has(args.name)) {
    return errorResult(`Reserved tool name: '${args.name}'. Choose a different name.`);
  }

  // Pre-flight: surface/layer mismatch
  if (args.surface === "layer1_build" && args.layer !== "layer1") {
    return errorResult("layer1_build surface requires layer='layer1'");
  }

  const root = args.repo_root ?? process.cwd();
  const camel = toCamel(args.name);
  const pascal = toPascal(args.name);
  const layerDir = layerToDir(args.layer);

  // Compute destination paths
  let toolPath: string;
  let testPath: string;

  if (args.surface === "prompt") {
    toolPath = path.join(root, "src", "prompts", `${camel}.ts`);
    testPath = path.join(root, "tests", "unit", `${camel}.test.ts`);
  } else {
    toolPath = path.join(root, "src", "tools", layerDir, `${camel}.ts`);
    testPath = path.join(root, "tests", "unit", `${camel}.test.ts`);
  }

  // Check collision
  const existing: string[] = [];
  for (const p of [toolPath, testPath]) {
    try {
      await fs.access(p);
      if (!args.overwrite) existing.push(p);
    } catch {
      // does not exist — fine
    }
  }
  if (existing.length > 0) {
    return errorResult(`File exists: ${existing.join(", ")}. Set overwrite=true to replace.`, {
      existing,
    });
  }

  // Render templates
  let toolContent: string;
  let testContent: string;

  if (args.surface === "prompt") {
    toolContent = templateD(args.name, camel, args.description);
    testContent = `// TODO: add tests for prompt ${camel}\n`;
  } else if (args.surface === "layer1_build") {
    toolContent = templateB(args.name, pascal, camel, args.description);
    testContent = templateTest(args.name, pascal, camel, args.surface, args.layer);
  } else if (args.surface === "local_only") {
    toolContent = templateC(args.name, pascal, camel, args.description);
    testContent = templateTest(args.name, pascal, camel, args.surface, args.layer);
  } else {
    // bridge (default)
    toolContent = templateA(args.name, pascal, camel, args.description);
    testContent = templateTest(args.name, pascal, camel, args.surface, args.layer);
  }

  // Write files
  const files: ScaffoldReport["files"] = [];
  try {
    await fs.mkdir(path.dirname(toolPath), { recursive: true });
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(toolPath, toolContent, "utf8");
    files.push({ path: toolPath, bytes: Buffer.byteLength(toolContent), created: true });
    await fs.writeFile(testPath, testContent, "utf8");
    files.push({ path: testPath, bytes: Buffer.byteLength(testContent), created: true });
  } catch (err) {
    return errorResult(`File write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Integration hint
  const layerIndexPath =
    args.surface === "prompt" ? "src/prompts/index.ts" : `src/tools/${layerDir}/index.ts`;

  const report: ScaffoldReport = {
    files,
    integration_hint: {
      registrar_import: `import { register${pascal} } from "./${camel}.js";`,
      registrar_array_entry: `register${pascal},`,
      layer_index_path: layerIndexPath,
      cli_command_name: toKebab(args.name),
      cli_command_args_hint: `--name ${args.name} --layer ${args.layer} --surface ${args.surface} --description "${args.description}"`,
    },
    warnings: [],
  };

  return structuredResult(
    `Scaffolded ${args.name} → ${files.map((f) => f.path).join(", ")}`,
    report,
  );
}

export const registerScaffoldToolGenerator: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "scaffold_tool_generator",
    {
      title: "Scaffold tool generator",
      description:
        "Meta DX tool: scaffolds a new tdmcp tool file (xSchema + xImpl + registerX) and a matching offline msw unit test from a one-line idea. Returns the exact integration-hint (import line + array entry + layer index path) so the integrator can wire it without re-deciding shape. No TouchDesigner bridge call — pure local filesystem generator.",
      inputSchema: scaffoldToolGeneratorSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => scaffoldToolGeneratorImpl(ctx, args),
  );
};
