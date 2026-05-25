import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { checkErrors } from "../../feedback/errorChecker.js";
import { capturePreview } from "../../feedback/previewCapture.js";
import type { Recipe } from "../../recipes/schema.js";
import { friendlyTdError } from "../../td-client/types.js";
import { connectNodesViaBridge } from "../layer2/connectHelper.js";
import { errorResult } from "../result.js";
import type { ToolContext } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/** Wraps a Layer 1 build, converting any thrown TD error into a friendly result. */
export async function runBuild(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export interface CreatedNode {
  name: string;
  path: string;
  type: string;
}

/**
 * Stateful helper for building a network inside a container. Connection / param
 * failures are collected as warnings rather than thrown, so a partial build still
 * returns useful information (fail-forward).
 */
export class NetworkBuilder {
  readonly created: CreatedNode[] = [];
  readonly warnings: string[] = [];
  private readonly nameToPath = new Map<string, string>();

  constructor(
    private readonly ctx: ToolContext,
    readonly containerPath: string,
  ) {}

  async add(type: string, name?: string, parameters?: Record<string, unknown>): Promise<string> {
    const ref = await this.ctx.client.createNode({
      parent_path: this.containerPath,
      type,
      name,
      parameters,
    });
    if (name) this.nameToPath.set(name, ref.path);
    if (ref.name) this.nameToPath.set(ref.name, ref.path);
    this.created.push({ name: ref.name || name || "", path: ref.path, type: ref.type || type });
    return ref.path;
  }

  pathOf(name: string): string | undefined {
    return this.nameToPath.get(name);
  }

  async connect(fromPath: string, toPath: string, fromOutput = 0, toInput = 0): Promise<void> {
    try {
      await connectNodesViaBridge(this.ctx.client, fromPath, toPath, fromOutput, toInput);
    } catch (err) {
      this.warnings.push(`Failed to connect ${fromPath} → ${toPath}: ${friendlyTdError(err)}`);
    }
  }

  async setParams(path: string, parameters: Record<string, unknown>): Promise<void> {
    try {
      await this.ctx.client.updateNodeParameters(path, parameters);
    } catch (err) {
      this.warnings.push(`Failed to set parameters on ${path}: ${friendlyTdError(err)}`);
    }
  }

  async python(code: string): Promise<void> {
    try {
      await this.ctx.client.executePythonScript(code, false);
    } catch (err) {
      this.warnings.push(`Python step failed: ${friendlyTdError(err)}`);
    }
  }
}

/** Creates a fresh base COMP to hold a visual system and returns a builder for it. */
export async function createSystemContainer(
  ctx: ToolContext,
  parentPath: string,
  name: string,
): Promise<NetworkBuilder> {
  const container = await ctx.client.createNode({
    parent_path: parentPath,
    type: "baseCOMP",
    name,
  });
  return new NetworkBuilder(ctx, container.path);
}

export interface RecipeBuildResult {
  builder: NetworkBuilder;
  outputPath?: string;
}

/** Instantiates a recipe inside a new container under `parentPath`. */
export async function buildFromRecipe(
  ctx: ToolContext,
  recipe: Recipe,
  parentPath: string,
): Promise<RecipeBuildResult> {
  const builder = await createSystemContainer(ctx, parentPath, recipe.id);

  for (const node of recipe.nodes) {
    await builder.add(node.type, node.name, node.parameters);
  }

  // Inline GLSL: place each shader in a Text DAT and point the GLSL TOP's pixeldat at it.
  if (recipe.glsl_code) {
    for (const [nodeName, code] of Object.entries(recipe.glsl_code)) {
      const target = builder.pathOf(nodeName);
      if (!target) {
        builder.warnings.push(`glsl_code references unknown node "${nodeName}".`);
        continue;
      }
      const fragPath = await builder.add("textDAT", `${nodeName}_frag`);
      await builder.python(
        `op(${q(fragPath)}).text = ${q(code)}\nop(${q(target)}).par.pixeldat = op(${q(fragPath)}).name`,
      );
    }
  }

  // Inline Python: set the target DAT's text.
  if (recipe.python_code) {
    for (const [nodeName, code] of Object.entries(recipe.python_code)) {
      const target = builder.pathOf(nodeName);
      if (!target) {
        builder.warnings.push(`python_code references unknown node "${nodeName}".`);
        continue;
      }
      await builder.python(`op(${q(target)}).text = ${q(code)}`);
    }
  }

  // Exposed parameters; a string value matching a node name resolves to that node's path.
  for (const param of recipe.parameters) {
    const target = builder.pathOf(param.node);
    if (!target) {
      builder.warnings.push(`Parameter "${param.name}" references unknown node "${param.node}".`);
      continue;
    }
    if (param.value === undefined) continue;
    let value = param.value;
    if (typeof value === "string") {
      const referenced = builder.pathOf(value);
      if (referenced) value = referenced;
    }
    await builder.setParams(target, { [param.param]: value });
  }

  for (const connection of recipe.connections) {
    const from = builder.pathOf(connection.from);
    const to = builder.pathOf(connection.to);
    if (!from || !to) {
      builder.warnings.push(
        `Connection ${connection.from} → ${connection.to} references an unknown node.`,
      );
      continue;
    }
    await builder.connect(from, to, connection.from_output, connection.to_input);
  }

  const outNode =
    recipe.nodes.find((n) => /^out/i.test(n.name)) ?? recipe.nodes[recipe.nodes.length - 1];
  const outputPath = outNode ? builder.pathOf(outNode.name) : undefined;
  return { builder, outputPath };
}

export interface FinalizeOptions {
  summary: string;
  builder: NetworkBuilder;
  outputPath?: string;
  recipeId?: string;
  capturePreviewImage?: boolean;
  extra?: Record<string, unknown>;
}

/**
 * Shared "verify → preview → respond" step for Layer 1 tools: runs an error check,
 * captures a preview of the output TOP, and returns a structured result with an
 * inline preview image when available.
 */
export async function finalize(
  ctx: ToolContext,
  options: FinalizeOptions,
): Promise<CallToolResult> {
  const { builder } = options;
  const warnings = [...builder.warnings];

  let errors: Array<{ path: string; message: string }> = [];
  try {
    const report = await checkErrors(ctx.client, builder.containerPath);
    errors = report.errors;
    if (report.hasErrors)
      warnings.push(`${report.errors.length} node error(s) detected after build.`);
  } catch (err) {
    warnings.push(`Error check unavailable: ${friendlyTdError(err)}`);
  }

  let previewBase64: string | undefined;
  let previewMime: string | undefined;
  if (options.capturePreviewImage !== false && options.outputPath) {
    try {
      const preview = await capturePreview(ctx.client, options.outputPath);
      previewBase64 = preview.base64;
      previewMime = preview.mimeType;
    } catch (err) {
      warnings.push(`Preview unavailable: ${friendlyTdError(err)}`);
    }
  }

  const data = {
    container: builder.containerPath,
    created: builder.created.map((c) => c.path),
    output: options.outputPath,
    recipe: options.recipeId,
    errors,
    warnings,
    ...options.extra,
  };

  const content: CallToolResult["content"] = [
    {
      type: "text",
      text: `${options.summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
    },
  ];
  if (previewBase64) {
    content.push({ type: "image", data: previewBase64, mimeType: previewMime ?? "image/png" });
  }
  return { content };
}
