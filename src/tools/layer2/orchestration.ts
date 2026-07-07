import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { checkErrors } from "../../feedback/errorChecker.js";
import { capturePreview } from "../../feedback/previewCapture.js";
import type { Recipe, RecipeGlslUniform } from "../../recipes/schema.js";
import { friendlyTdError, isMissingEndpoint } from "../../td-client/types.js";
import {
  computeLayoutByParent,
  type LayoutEdge,
  layoutScript,
  placeInGridScript,
} from "../layout.js";
import { parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext } from "../types.js";
import { connectNodesViaBridge } from "./connectHelper.js";
import { buildPanelScript, type ControlSpec } from "./createControlPanel.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Maps each GLSL TOP uniform kind to the parameter *sequence* that binds it and the
 * per-block value sub-parameter suffixes (verified against a live GLSL TOP). A scalar
 * `uniform float` and a `uniform vecN` both bind through the "Vectors" page (the `vec`
 * sequence) — a float just fills the first (`valuex`) component; `color` binds through
 * the "Colors" page (the `color` sequence). The block name lives at `<seq><i>name`,
 * the values at `<seq><i><suffix>`. (The "Constants" page does not feed `uniform float`.)
 */
const UNIFORM_KINDS: Record<
  RecipeGlslUniform["kind"],
  { seq: "vec" | "color"; fields: readonly string[] }
> = {
  float: { seq: "vec", fields: ["valuex"] },
  vec: { seq: "vec", fields: ["valuex", "valuey", "valuez", "valuew"] },
  color: { seq: "color", fields: ["rgbr", "rgbg", "rgbb", "alpha"] },
};

interface UniformGroup {
  node: string;
  seq: "vec" | "color";
  items: RecipeGlslUniform[];
}

/**
 * Groups uniforms by node + binding sequence, preserving order (block index = position
 * in group). `float` and `vec` share the `vec` sequence, so they land in one group and
 * receive distinct block indices.
 */
function groupUniforms(uniforms: readonly RecipeGlslUniform[]): UniformGroup[] {
  const groups = new Map<string, UniformGroup>();
  for (const uniform of uniforms) {
    const { seq } = UNIFORM_KINDS[uniform.kind];
    const key = `${uniform.node} ${seq}`;
    let group = groups.get(key);
    if (!group) {
      group = { node: uniform.node, seq, items: [] };
      groups.set(key, group);
    }
    group.items.push(uniform);
  }
  return [...groups.values()];
}

/**
 * Conversion operators (e.g. `choptoTOP`, `dattoCHOP`, `toptoCHOP`, `soptoDAT`)
 * read their source from a parameter named after the source family, not from a
 * connector wire. Returns that parameter name (`chop`/`dat`/`top`/`sop`) or undefined.
 */
function converterSourceParam(type: string): string | undefined {
  const match = /^(chop|dat|top|sop)to/i.exec(type);
  return match?.[1]?.toLowerCase();
}

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
  private readonly pathToType = new Map<string, string>();
  // Intended data-flow wires, recorded even when the physical connect fails or is
  // satisfied via a source parameter, so auto-layout still reflects the flow.
  private readonly edges: LayoutEdge[] = [];

  constructor(
    private readonly ctx: ToolContext,
    readonly containerPath: string,
  ) {}

  async add(
    type: string,
    name?: string,
    parameters?: Record<string, unknown>,
    parentPath?: string,
  ): Promise<string> {
    const ref = await this.ctx.client.createNode({
      parent_path: parentPath ?? this.containerPath,
      type,
      name,
      parameters,
    });
    if (name) this.nameToPath.set(name, ref.path);
    if (ref.name) this.nameToPath.set(ref.name, ref.path);
    this.pathToType.set(ref.path, ref.type || type);
    this.created.push({ name: ref.name || name || "", path: ref.path, type: ref.type || type });
    // The bridge creates the node regardless but reports any params it could not
    // apply (unknown token or bad value). Surface them as warnings — otherwise a
    // typo'd parameter name (e.g. a nonexistent displaceTOP token) fails silently
    // and the build looks clean while the effect never takes hold.
    if (ref.parameter_warnings?.length) {
      this.warnings.push(
        `Parameter(s) not applied on ${ref.name || name || ref.path} (${ref.type || type}) — unknown name or bad value: ${ref.parameter_warnings.join(", ")}.`,
      );
    }
    // A fresh geometryCOMP ships with a default torus1 that renders over the real
    // geometry; clear its default children before the builder populates it.
    if (/geometrycomp/i.test(type)) {
      await this.python(`_g = op(${q(ref.path)})\nfor _c in list(_g.children):\n    _c.destroy()`);
    }
    return ref.path;
  }

  pathOf(name: string): string | undefined {
    return this.nameToPath.get(name);
  }

  async connect(fromPath: string, toPath: string, fromOutput = 0, toInput = 0): Promise<void> {
    this.edges.push({ from: fromPath, to: toPath });
    // Conversion ops (choptoTOP, dattoCHOP, …) take their source via a parameter.
    const targetType = this.pathToType.get(toPath);
    const param = targetType ? converterSourceParam(targetType) : undefined;
    if (param) {
      await this.setParams(toPath, { [param]: fromPath });
      return;
    }
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

  async setParamExpr(path: string, param: string, expr: string): Promise<void> {
    try {
      await this.ctx.client.setParameterMode(path, param, "expression", expr);
      return;
    } catch (err) {
      if (!isMissingEndpoint(err)) {
        this.warnings.push(`Failed to set expression on ${path}.${param}: ${friendlyTdError(err)}`);
        return;
      }
    }
    // Older bridge without the param-mode endpoint: set the expression via exec.
    // Look the parameter up by name via getattr so a name that isn't a valid Python
    // identifier can't break the script (and isn't string-interpolated as code).
    // Assigning `.expr` alone leaves the parameter in Constant mode, so flip the mode
    // to EXPRESSION too. ParMode is not importable as a global, so resolve the enum
    // from the live parameter (`type(_par.mode).EXPRESSION`).
    await this.python(
      `_par = getattr(op(${q(path)}).par, ${q(param)})\n_par.expr = ${q(expr)}\n_par.mode = type(_par.mode).EXPRESSION`,
    );
  }

  async python(code: string): Promise<void> {
    try {
      await this.ctx.client.executePythonScript(code, false);
    } catch (err) {
      this.warnings.push(`Python step failed: ${friendlyTdError(err)}`);
    }
  }

  /** Arranges every created node left→right along the recorded data flow. */
  async layout(): Promise<void> {
    const positions = computeLayoutByParent(
      this.created.map((c) => c.path),
      this.edges,
    );
    if (Object.keys(positions).length === 0) return;
    try {
      await this.ctx.client.executePythonScript(layoutScript(positions), false);
    } catch (err) {
      this.warnings.push(`Auto-layout skipped: ${friendlyTdError(err)}`);
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
  // Tile the container into a 2D grid clear of existing siblings, so repeated
  // generations read as a grid instead of overlapping at the origin. Cosmetic only —
  // a failure here must never abort the build.
  try {
    await ctx.client.executePythonScript(placeInGridScript(parentPath, container.path), false);
  } catch (err) {
    ctx.logger.debug("container placement skipped", { err: String(err) });
  }
  return new NetworkBuilder(ctx, container.path);
}

export interface RecipeBuildResult {
  builder: NetworkBuilder;
  outputPath?: string;
  /** Controls to auto-expose, with `bind_to` already resolved to real node paths. */
  controls?: ControlSpec[];
}

/** Rewrites op('<recipeNodeName>') references in an expression to real created paths. */
function resolveExprRefs(expr: string, builder: NetworkBuilder): string {
  return expr.replace(/op\((['"])([^'"]+)\1\)/g, (match, _quote, name: string) => {
    const path = builder.pathOf(name);
    return path ? `op('${path}')` : match;
  });
}

/**
 * Applies a recipe's exposed parameters. An `expr` binds the parameter in
 * expression mode (with op(name) refs rewritten to real paths); otherwise the
 * `value` is set as a constant, resolving a string that matches a node name to
 * that node's path.
 */
async function applyRecipeParameters(
  builder: NetworkBuilder,
  parameters: Recipe["parameters"],
): Promise<void> {
  for (const param of parameters) {
    const target = builder.pathOf(param.node);
    if (!target) {
      builder.warnings.push(`Parameter "${param.name}" references unknown node "${param.node}".`);
      continue;
    }
    if (param.expr !== undefined) {
      await builder.setParamExpr(target, param.param, resolveExprRefs(param.expr, builder));
      continue;
    }
    if (param.value === undefined) continue;
    const value =
      typeof param.value === "string" ? (builder.pathOf(param.value) ?? param.value) : param.value;
    await builder.setParams(target, { [param.param]: value });
  }
}

/** Instantiates a recipe inside a new container under `parentPath`. */
export async function buildFromRecipe(
  ctx: ToolContext,
  recipe: Recipe,
  parentPath: string,
  containerName = recipe.id,
): Promise<RecipeBuildResult> {
  const builder = await createSystemContainer(ctx, parentPath, containerName);

  for (const node of recipe.nodes) {
    let parentPath: string | undefined;
    if (node.parent) {
      parentPath = builder.pathOf(node.parent);
      if (!parentPath) {
        builder.warnings.push(
          `Node "${node.name}" references unknown parent "${node.parent}" (it must appear earlier in nodes).`,
        );
      }
    }
    await builder.add(node.type, node.name, node.parameters, parentPath);
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

  // GLSL TOP uniforms: these live in parameter sequences, so the block count must be
  // raised (op.seq.<seq>.numBlocks, which has no structured setter) before the
  // per-block name/value sub-parameters exist and can be set the normal way.
  for (const group of groupUniforms(recipe.glsl_uniforms)) {
    const target = builder.pathOf(group.node);
    if (!target) {
      builder.warnings.push(`glsl_uniforms references unknown node "${group.node}".`);
      continue;
    }
    await builder.python(
      `_seq = op(${q(target)}).seq.${group.seq}\n_seq.numBlocks = max(_seq.numBlocks, ${group.items.length})`,
    );
    for (const [i, uniform] of group.items.entries()) {
      const { fields } = UNIFORM_KINDS[uniform.kind];
      const params: Record<string, unknown> = { [`${group.seq}${i}name`]: uniform.name };
      const values = Array.isArray(uniform.value)
        ? uniform.value
        : uniform.value === undefined
          ? []
          : [uniform.value];
      for (const [j, field] of fields.entries()) {
        const value = values[j];
        if (value !== undefined) params[`${group.seq}${i}${field}`] = value;
      }
      await builder.setParams(target, params);
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

  await applyRecipeParameters(builder, recipe.parameters);

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

  // Nested render geometry: make each flagged SOP the one its parent COMP renders,
  // clearing its siblings (including the COMP's default torus).
  for (const node of recipe.nodes) {
    if (!node.render) continue;
    const target = builder.pathOf(node.name);
    if (!target) continue;
    await builder.python(
      `_n = op(${q(target)})\n_p = _n.parent()\nfor _c in _p.children:\n    _c.render = False\n    _c.display = False\n_n.render = True\n_n.display = True`,
    );
  }

  const outNode =
    recipe.nodes.find((n) => /^out/i.test(n.name)) ?? recipe.nodes[recipe.nodes.length - 1];
  const outputPath = outNode ? builder.pathOf(outNode.name) : undefined;

  // Resolve each control's bind targets from recipe node *names* to the real created
  // paths, so the panel can bind them. An unresolved name is left as-is (it surfaces as
  // a warning when the panel runs).
  const controls: ControlSpec[] = recipe.controls.map((control) => ({
    ...control,
    bind_to: control.bind_to?.map((target) => {
      const dot = target.lastIndexOf(".");
      if (dot <= 0) return target;
      const path = builder.pathOf(target.slice(0, dot));
      return path ? `${path}.${target.slice(dot + 1)}` : target;
    }),
  }));

  return { builder, outputPath, controls };
}

export interface FinalizeOptions {
  summary: string;
  builder: NetworkBuilder;
  outputPath?: string;
  recipeId?: string;
  capturePreviewImage?: boolean;
  /**
   * Controls to expose on the system container so the generated network is immediately
   * playable (knobs/sliders bound to its key parameters). Failures are folded into the
   * response warnings — they never abort the build.
   */
  controls?: ControlSpec[];
  extra?: Record<string, unknown>;
}

interface ExposeControlsResult {
  created: Array<{ name: string }>;
  bound: Array<{ control: string; target: string }>;
  warnings: string[];
  fatal?: string;
}

/**
 * Appends a control panel (custom parameters bound to node parameters) to the system
 * container, reusing the same Python pass as the create_control_panel tool. Fail-forward:
 * any error is returned as a warning rather than thrown.
 */
async function exposeControls(
  ctx: ToolContext,
  compPath: string,
  controls: ControlSpec[],
): Promise<ExposeControlsResult> {
  try {
    const script = buildPanelScript({ comp: compPath, page: "Controls", controls });
    const exec = await ctx.client.executePythonScript(script, true);
    return parsePythonReport<ExposeControlsResult>(exec.stdout);
  } catch (err) {
    return { created: [], bound: [], warnings: [`Control panel skipped: ${friendlyTdError(err)}`] };
  }
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
  await builder.layout();
  const warnings = [...builder.warnings];

  // Expose live controls on the container so the generated system is playable on arrival.
  let controlsSummary: { added: string[]; bound: number } | undefined;
  if (options.controls?.length) {
    const result = await exposeControls(ctx, builder.containerPath, options.controls);
    warnings.push(...result.warnings);
    if (result.fatal) warnings.push(`Control panel skipped: ${result.fatal}`);
    else controlsSummary = { added: result.created.map((c) => c.name), bound: result.bound.length };
  }

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
    controls: controlsSummary,
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
