import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { capturePreview } from "../feedback/previewCapture.js";
import { buildToolContext } from "../server/context.js";
import { type TdEventHandler, TdEventStream } from "../td-client/eventStream.js";
import { friendlyTdError } from "../td-client/types.js";
import {
  applyPostProcessingImpl,
  applyPostProcessingSchema,
} from "../tools/layer1/applyPostProcessing.js";
import { create3dSceneImpl, create3dSceneSchema } from "../tools/layer1/create3dScene.js";
import {
  createAudioReactiveImpl,
  createAudioReactiveSchema,
} from "../tools/layer1/createAudioReactive.js";
import {
  createDataVisualizationImpl,
  createDataVisualizationSchema,
} from "../tools/layer1/createDataVisualization.js";
import {
  createFeedbackNetworkImpl,
  createFeedbackNetworkSchema,
} from "../tools/layer1/createFeedbackNetwork.js";
import {
  createGenerativeArtImpl,
  createGenerativeArtSchema,
} from "../tools/layer1/createGenerativeArt.js";
import {
  createKeyframeAnimationImpl,
  createKeyframeAnimationSchema,
} from "../tools/layer1/createKeyframeAnimation.js";
import { createLayerMixerImpl, createLayerMixerSchema } from "../tools/layer1/createLayerMixer.js";
import {
  createParticleSystemImpl,
  createParticleSystemSchema,
} from "../tools/layer1/createParticleSystem.js";
import {
  createProjectionMappingImpl,
  createProjectionMappingSchema,
} from "../tools/layer1/createProjectionMapping.js";
import { createSimulationImpl, createSimulationSchema } from "../tools/layer1/createSimulation.js";
import { createTempoSyncImpl, createTempoSyncSchema } from "../tools/layer1/createTempoSync.js";
import {
  createVideoPlayerImpl,
  createVideoPlayerSchema,
} from "../tools/layer1/createVideoPlayer.js";
import {
  createVisualSystemImpl,
  createVisualSystemSchema,
} from "../tools/layer1/createVisualSystem.js";
import { describeProjectImpl, describeProjectSchema } from "../tools/layer1/describeProject.js";
import {
  extractAudioFeaturesImpl,
  extractAudioFeaturesSchema,
} from "../tools/layer1/extractAudioFeatures.js";
import { getPreviewSchema } from "../tools/layer1/getPreview.js";
import { setupOutputImpl, setupOutputSchema } from "../tools/layer1/setupOutput.js";
import { animateParameterImpl, animateParameterSchema } from "../tools/layer2/animateParameter.js";
import { arrangeNetworkImpl, arrangeNetworkSchema } from "../tools/layer2/arrangeNetwork.js";
import { bindToChannelImpl, bindToChannelSchema } from "../tools/layer2/bindToChannel.js";
import { connectNodesImpl, connectNodesSchema } from "../tools/layer2/connectNodes.js";
import { createContainerImpl, createContainerSchema } from "../tools/layer2/createContainer.js";
import {
  createControlPanelImpl,
  createControlPanelSchema,
} from "../tools/layer2/createControlPanel.js";
import {
  createControlSurfaceImpl,
  createControlSurfaceSchema,
} from "../tools/layer2/createControlSurface.js";
import { createExternalIoImpl, createExternalIoSchema } from "../tools/layer2/createExternalIo.js";
import { createGlslShaderImpl, createGlslShaderSchema } from "../tools/layer2/createGlslShader.js";
import { createMacroImpl, createMacroSchema } from "../tools/layer2/createMacro.js";
import { createNodeChainImpl, createNodeChainSchema } from "../tools/layer2/createNodeChain.js";
import {
  createPhoneRemoteImpl,
  createPhoneRemoteSchema,
} from "../tools/layer2/createPhoneRemote.js";
import {
  createPythonScriptImpl,
  createPythonScriptSchema,
} from "../tools/layer2/createPythonScript.js";
import { duplicateNetworkImpl, duplicateNetworkSchema } from "../tools/layer2/duplicateNetwork.js";
import { manageCheckpointImpl, manageCheckpointSchema } from "../tools/layer2/manageCheckpoint.js";
import { manageComponentImpl, manageComponentSchema } from "../tools/layer2/manageComponent.js";
import { manageCueImpl, manageCueSchema } from "../tools/layer2/manageCue.js";
import { managePresetsImpl, managePresetsSchema } from "../tools/layer2/managePresets.js";
import {
  randomizeControlsImpl,
  randomizeControlsSchema,
} from "../tools/layer2/randomizeControls.js";
import {
  setParametersBatchImpl,
  setParametersBatchSchema,
} from "../tools/layer2/setParametersBatch.js";
import { compareTdNodesImpl, compareTdNodesSchema } from "../tools/layer3/compareTdNodes.js";
import { createTdNodeImpl, createTdNodeSchema } from "../tools/layer3/createTdNode.js";
import { deleteTdNodeImpl, deleteTdNodeSchema } from "../tools/layer3/deleteTdNode.js";
import { execNodeMethodImpl, execNodeMethodSchema } from "../tools/layer3/execNodeMethod.js";
import {
  executePythonScriptImpl,
  executePythonScriptSchema,
} from "../tools/layer3/executePythonScript.js";
import { findTdNodesImpl, findTdNodesSchema } from "../tools/layer3/findTdNodes.js";
import { getModuleHelpImpl, getModuleHelpSchema } from "../tools/layer3/getModuleHelp.js";
import {
  getTdClassDetailsImpl,
  getTdClassDetailsSchema,
} from "../tools/layer3/getTdClassDetails.js";
import { getTdClassesImpl, getTdClassesSchema } from "../tools/layer3/getTdClasses.js";
import { getTdInfoImpl } from "../tools/layer3/getTdInfo.js";
import { getTdNodeErrorsImpl, getTdNodeErrorsSchema } from "../tools/layer3/getTdNodeErrors.js";
import {
  getTdNodeParametersImpl,
  getTdNodeParametersSchema,
} from "../tools/layer3/getTdNodeParameters.js";
import { getTdNodesImpl, getTdNodesSchema } from "../tools/layer3/getTdNodes.js";
import { getTdPerformanceImpl, getTdPerformanceSchema } from "../tools/layer3/getTdPerformance.js";
import { getTdTopologyImpl, getTdTopologySchema } from "../tools/layer3/getTdTopology.js";
import { reloadBridgeImpl, reloadBridgeSchema } from "../tools/layer3/reloadBridge.js";
import { snapshotTdGraphImpl, snapshotTdGraphSchema } from "../tools/layer3/snapshotTdGraph.js";
import {
  summarizeTdErrorsImpl,
  summarizeTdErrorsSchema,
} from "../tools/layer3/summarizeTdErrors.js";
import {
  updateTdNodeParametersImpl,
  updateTdNodeParametersSchema,
} from "../tools/layer3/updateTdNodeParameters.js";
import type { ToolContext } from "../tools/types.js";
import { loadConfig, type TdmcpConfig, tdBaseUrl } from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";

// biome-ignore lint/suspicious/noExplicitAny: args are validated by each command's zod schema before use.
type Runner = (ctx: ToolContext, args: any) => CallToolResult | Promise<CallToolResult>;

interface Command {
  schema: z.ZodTypeAny;
  run: Runner;
  summary: string;
  mutates: boolean;
  unsafe: boolean;
}

const r = (
  schema: z.ZodTypeAny,
  run: Runner,
  summary: string,
  opts: { mutates?: boolean; unsafe?: boolean } = {},
): Command => ({ schema, run, summary, mutates: !!opts.mutates, unsafe: !!opts.unsafe });

/** Static command tree — each entry maps 1:1 onto an existing MCP tool handler. */
const COMMANDS: Record<string, Command> = {
  info: r(z.object({}), (ctx) => getTdInfoImpl(ctx), "Health check + TD/bridge info."),
  reload: r(
    reloadBridgeSchema,
    reloadBridgeImpl,
    "Hot-reload the bridge's Python after editing td/.",
  ),
  "nodes list": r(
    getTdNodesSchema,
    getTdNodesImpl,
    "List a COMP's child nodes (summary by default).",
  ),
  "nodes find": r(findTdNodesSchema, findTdNodesImpl, "Search nodes by name pattern and/or type."),
  "nodes get": r(getTdNodeParametersSchema, getTdNodeParametersImpl, "Read a node's parameters."),
  "nodes errors": r(getTdNodeErrorsSchema, getTdNodeErrorsImpl, "Check a node/network for errors."),
  "nodes compare": r(compareTdNodesSchema, compareTdNodesImpl, "Diff two nodes' parameters."),
  "nodes snapshot": r(snapshotTdGraphSchema, snapshotTdGraphImpl, "Capture a network snapshot."),
  "nodes topology": r(getTdTopologySchema, getTdTopologyImpl, "Map nodes + connections."),
  "nodes performance": r(getTdPerformanceSchema, getTdPerformanceImpl, "Report cook times."),
  "nodes update": r(
    updateTdNodeParametersSchema,
    updateTdNodeParametersImpl,
    "Set node parameters.",
    { mutates: true },
  ),
  "nodes create": r(createTdNodeSchema, createTdNodeImpl, "Create an operator.", { mutates: true }),
  "nodes delete": r(deleteTdNodeSchema, deleteTdNodeImpl, "Delete a node.", { mutates: true }),
  "errors summarize": r(
    summarizeTdErrorsSchema,
    summarizeTdErrorsImpl,
    "Cluster network errors by cause.",
  ),
  "classes list": r(getTdClassesSchema, getTdClassesImpl, "List TD Python API classes (offline)."),
  "classes get": r(
    getTdClassDetailsSchema,
    getTdClassDetailsImpl,
    "Get one Python class (offline).",
  ),
  "module help": r(
    getModuleHelpSchema,
    getModuleHelpImpl,
    "Human-readable help for a class (offline).",
  ),
  "exec python": r(
    executePythonScriptSchema,
    executePythonScriptImpl,
    "Escape hatch: run arbitrary Python in TD.",
    { mutates: true, unsafe: true },
  ),
  "exec node-method": r(
    execNodeMethodSchema,
    execNodeMethodImpl,
    "Escape hatch: call a Python method on a node.",
    { mutates: true, unsafe: true },
  ),
  // Layer 1 — high-level generators (each builds a whole network, verifies, previews).
  visual: r(
    createVisualSystemSchema,
    createVisualSystemImpl,
    "Build a visual system from a description.",
    { mutates: true },
  ),
  feedback: r(createFeedbackNetworkSchema, createFeedbackNetworkImpl, "Build a feedback network.", {
    mutates: true,
  }),
  generative: r(
    createGenerativeArtSchema,
    createGenerativeArtImpl,
    "Build a generative-art system.",
    { mutates: true },
  ),
  particles: r(createParticleSystemSchema, createParticleSystemImpl, "Build a particle system.", {
    mutates: true,
  }),
  "audio-reactive": r(
    createAudioReactiveSchema,
    createAudioReactiveImpl,
    "Build an audio-reactive visual.",
    { mutates: true },
  ),
  "audio-features": r(
    extractAudioFeaturesSchema,
    extractAudioFeaturesImpl,
    "Extract reactive channels (level/bass/mid/treble) to bind to params.",
    { mutates: true },
  ),
  "tempo-sync": r(
    createTempoSyncSchema,
    createTempoSyncImpl,
    "Create a beat clock (ramp/pulse/beat/bar/bpm) + optional beat events.",
    { mutates: true },
  ),
  dataviz: r(
    createDataVisualizationSchema,
    createDataVisualizationImpl,
    "Build a data visualization.",
    { mutates: true },
  ),
  mixer: r(
    createLayerMixerSchema,
    createLayerMixerImpl,
    "Build a VJ layer mixer (crossfade/blend).",
    {
      mutates: true,
    },
  ),
  video: r(
    createVideoPlayerSchema,
    createVideoPlayerImpl,
    "Build a movie/clip player (+playlist).",
    {
      mutates: true,
    },
  ),
  scene3d: r(create3dSceneSchema, create3dSceneImpl, "Build a renderable 3D scene.", {
    mutates: true,
  }),
  mapping: r(
    createProjectionMappingSchema,
    createProjectionMappingImpl,
    "Wrap a source in a corner-pin for projection mapping.",
    { mutates: true },
  ),
  keyframe: r(
    createKeyframeAnimationSchema,
    createKeyframeAnimationImpl,
    "Animate parameters along a keyframed curve (synced/looping).",
    { mutates: true },
  ),
  simulation: r(
    createSimulationSchema,
    createSimulationImpl,
    "Build a GPU simulation (RD/slime/fluid).",
    {
      mutates: true,
    },
  ),
  "post-fx": r(
    applyPostProcessingSchema,
    applyPostProcessingImpl,
    "Apply post-processing (bloom/blur/…).",
    { mutates: true },
  ),
  output: r(setupOutputSchema, setupOutputImpl, "Set up a window / NDI / Syphon-Spout output.", {
    mutates: true,
  }),
  plan: r(
    describeProjectSchema,
    describeProjectImpl,
    "Plan which tool/recipe builds a described visual (creates nothing).",
  ),
  // Layer 2 — building blocks.
  animate: r(animateParameterSchema, animateParameterImpl, "Drive parameters with an LFO.", {
    mutates: true,
  }),
  bind: r(
    bindToChannelSchema,
    bindToChannelImpl,
    "Bind parameters to a CHOP channel (audio feature / beat) by expression.",
    { mutates: true },
  ),
  arrange: r(arrangeNetworkSchema, arrangeNetworkImpl, "Auto-arrange a network left→right.", {
    mutates: true,
  }),
  connect: r(connectNodesSchema, connectNodesImpl, "Wire two nodes together.", { mutates: true }),
  container: r(createContainerSchema, createContainerImpl, "Create a COMP container.", {
    mutates: true,
  }),
  "control-panel": r(
    createControlPanelSchema,
    createControlPanelImpl,
    "Add bound custom-parameter controls to a COMP.",
    { mutates: true },
  ),
  surface: r(
    createControlSurfaceSchema,
    createControlSurfaceImpl,
    "Build a playable panel: faders + cue buttons.",
    { mutates: true },
  ),
  remote: r(
    createPhoneRemoteSchema,
    createPhoneRemoteImpl,
    "Serve a phone web panel for a COMP's controls.",
    { mutates: true },
  ),
  io: r(
    createExternalIoSchema,
    createExternalIoImpl,
    "Bridge OSC/MIDI in, DMX out, NDI/Syphon in.",
    {
      mutates: true,
    },
  ),
  glsl: r(createGlslShaderSchema, createGlslShaderImpl, "Create a GLSL TOP shader.", {
    mutates: true,
  }),
  chain: r(createNodeChainSchema, createNodeChainImpl, "Create a chain of connected nodes.", {
    mutates: true,
  }),
  script: r(
    createPythonScriptSchema,
    createPythonScriptImpl,
    "Create a DAT preloaded with Python.",
    {
      mutates: true,
    },
  ),
  duplicate: r(duplicateNetworkSchema, duplicateNetworkImpl, "Duplicate a network.", {
    mutates: true,
  }),
  component: r(manageComponentSchema, manageComponentImpl, "Save/load a COMP as a .tox.", {
    mutates: true,
  }),
  checkpoint: r(
    manageCheckpointSchema,
    manageCheckpointImpl,
    "Store/restore a full sub-network snapshot (undo point).",
    { mutates: true },
  ),
  preset: r(managePresetsSchema, managePresetsImpl, "Store/recall/list/delete COMP presets.", {
    mutates: true,
  }),
  cue: r(
    manageCueSchema,
    manageCueImpl,
    "Scene system: store/recall/morph/list/delete cues (timed crossfade).",
    { mutates: true },
  ),
  macro: r(createMacroSchema, createMacroImpl, "Add one knob that drives many parameters.", {
    mutates: true,
  }),
  randomize: r(
    randomizeControlsSchema,
    randomizeControlsImpl,
    "Randomize a COMP's numeric controls within range.",
    { mutates: true },
  ),
  params: r(
    setParametersBatchSchema,
    setParametersBatchImpl,
    "Set many parameters across nodes at once.",
    { mutates: true },
  ),
};

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Prefer the structured channel; fall back to a JSON code-fence, then to the raw text. */
function extractData(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  const fence = text.match(/```json\n([\s\S]*?)\n```/);
  if (fence) {
    try {
      return JSON.parse(fence[1] as string);
    } catch {
      // fall through
    }
  }
  return { message: text };
}

function firstArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) if (Array.isArray(value)) return value;
  }
  return null;
}

function resolveCommand(positionals: string[]): { key: string; cmd: Command } | undefined {
  const key2 = positionals.slice(0, 2).join(" ");
  if (COMMANDS[key2]) return { key: key2, cmd: COMMANDS[key2] };
  const key1 = positionals[0] ?? "";
  if (COMMANDS[key1]) return { key: key1, cmd: COMMANDS[key1] };
  return undefined;
}

function usage(): string {
  const lines = ["tdmcp-agent — drive TouchDesigner from a shell (machine-readable output).", ""];
  lines.push("Usage: tdmcp-agent <command> [--params '<json>'] [--json '<json>'] [flags]", "");
  lines.push("Flags:");
  lines.push(
    "  --params <json>   Arguments object (validated against the command's input schema).",
  );
  lines.push("  --json <json>     Merged into --params (e.g. for request bodies).");
  lines.push("  --output <fmt>    json (default) | ndjson | text.");
  lines.push("  --dry-run         Validate and print the intended call without executing.");
  lines.push("  --allow-unsafe    Required for `exec` escape-hatch commands.");
  lines.push("  -o, --out <file>  (preview) Output PNG path. Defaults to ./preview.png.");
  lines.push("  --include-high-frequency  (watch) Also stream timeline.frame / node.cook events.");
  lines.push("  -h, --help        Show this help.", "");
  lines.push("Commands:");
  for (const [key, cmd] of Object.entries(COMMANDS)) {
    const tags = [cmd.mutates ? "mutates" : "", cmd.unsafe ? "unsafe" : ""]
      .filter(Boolean)
      .join(",");
    lines.push(`  ${key.padEnd(20)} ${cmd.summary}${tags ? `  [${tags}]` : ""}`);
  }
  lines.push("  schema <command>     Print a command's JSON Schema and metadata.");
  lines.push("  preview <nodePath>   Capture a TOP to a PNG file (-o/--out).  [writes a file]");
  lines.push("  watch                Stream TD events as ndjson until Ctrl-C.  [long-running]");
  return lines.join("\n");
}

export interface RunCliOptions {
  /** Inject a context (used by tests); production builds one from env config. */
  makeCtx?: () => ToolContext;
}

function buildCtx(opts: RunCliOptions): ToolContext {
  return opts.makeCtx ? opts.makeCtx() : buildToolContext(loadConfig(), { logger: silentLogger });
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      params: { type: "string" },
      json: { type: "string" },
      output: { type: "string", default: "json" },
      "dry-run": { type: "boolean", default: false },
      "allow-unsafe": { type: "boolean", default: false },
      out: { type: "string", short: "o" },
      "include-high-frequency": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
  }

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    return { stdout: `${usage()}\n`, stderr: "", code: 0 };
  }

  // `schema <command>` — emit the input contract without touching TD.
  if (positionals[0] === "schema") {
    const target = positionals.slice(1).join(" ");
    const cmd = COMMANDS[target];
    if (!cmd) return { stdout: "", stderr: `Unknown command for schema: "${target}".\n`, code: 2 };
    const doc = {
      command: target,
      summary: cmd.summary,
      mutates: cmd.mutates,
      unsafe: cmd.unsafe,
      input: z.toJSONSchema(cmd.schema),
    };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }

  // `preview <nodePath> -o file.png` — capture a TOP and write it to disk. This is a
  // side effect that doesn't fit the CallToolResult command table, so it's handled here.
  if (positionals[0] === "preview") {
    const raw: Record<string, unknown> = {};
    try {
      if (typeof values.params === "string") Object.assign(raw, JSON.parse(values.params));
      if (typeof values.json === "string") Object.assign(raw, JSON.parse(values.json));
    } catch (err) {
      return {
        stdout: "",
        stderr: `Invalid JSON in --params/--json: ${(err as Error).message}\n`,
        code: 2,
      };
    }
    if (positionals[1]) raw.node_path = positionals[1];
    const parsed = getPreviewSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        stdout: "",
        stderr: `Invalid arguments for "preview": ${parsed.error.message}\n`,
        code: 2,
      };
    }
    const outPath = typeof values.out === "string" && values.out ? values.out : "preview.png";
    if (values["dry-run"]) {
      const doc = { dryRun: true, command: "preview", args: parsed.data, out: resolve(outPath) };
      return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
    }
    const ctx = buildCtx(opts);
    try {
      const preview = await capturePreview(
        ctx.client,
        parsed.data.node_path,
        parsed.data.width,
        parsed.data.height,
      );
      const bytes = Buffer.from(preview.base64, "base64");
      writeFileSync(outPath, bytes);
      const doc = {
        node_path: preview.path,
        file: resolve(outPath),
        width: preview.width,
        height: preview.height,
        bytes: bytes.length,
        mimeType: preview.mimeType,
      };
      return {
        stdout: `${JSON.stringify(doc, null, 2)}\n`,
        stderr: `Saved preview of ${preview.path} to ${outPath} (${bytes.length} bytes).\n`,
        code: 0,
      };
    } catch (err) {
      return { stdout: "", stderr: `${friendlyTdError(err)}\n`, code: 1 };
    }
  }

  const resolved = resolveCommand(positionals);
  if (!resolved) {
    return {
      stdout: "",
      stderr: `Unknown command: "${positionals.join(" ")}". Run with --help.\n`,
      code: 2,
    };
  }
  const { key, cmd } = resolved;

  const raw: Record<string, unknown> = {};
  try {
    if (typeof values.params === "string") Object.assign(raw, JSON.parse(values.params));
    if (typeof values.json === "string") Object.assign(raw, JSON.parse(values.json));
  } catch (err) {
    return {
      stdout: "",
      stderr: `Invalid JSON in --params/--json: ${(err as Error).message}\n`,
      code: 2,
    };
  }

  const args = cmd.schema.safeParse(raw);
  if (!args.success) {
    return {
      stdout: "",
      stderr: `Invalid arguments for "${key}": ${args.error.message}\n`,
      code: 2,
    };
  }

  if (values["dry-run"]) {
    const doc = {
      dryRun: true,
      command: key,
      mutates: cmd.mutates,
      unsafe: cmd.unsafe,
      args: args.data,
    };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }

  const ctx = buildCtx(opts);

  if (cmd.unsafe) {
    if (ctx.allowRawPython === false) {
      return { stdout: "", stderr: `"${key}" is disabled (TDMCP_RAW_PYTHON=off).\n`, code: 2 };
    }
    if (!values["allow-unsafe"]) {
      return {
        stdout: "",
        stderr: `"${key}" is an escape hatch. Re-run with --allow-unsafe to execute.\n`,
        code: 2,
      };
    }
  }

  const result = await cmd.run(ctx, args.data);
  const summary = textOf(result).split("\n")[0] ?? "";
  if (result.isError) return { stdout: "", stderr: `${textOf(result)}\n`, code: 1 };

  const output = String(values.output);
  const data = extractData(result);
  if (output === "text") return { stdout: `${textOf(result)}\n`, stderr: "", code: 0 };
  if (output === "ndjson") {
    const arr = firstArray(data);
    const body = arr ? arr.map((item) => JSON.stringify(item)).join("\n") : JSON.stringify(data);
    return { stdout: `${body}\n`, stderr: summary ? `${summary}\n` : "", code: 0 };
  }
  return {
    stdout: `${JSON.stringify(data, null, 2)}\n`,
    stderr: summary ? `${summary}\n` : "",
    code: 0,
  };
}

export interface RunWatchOptions {
  config?: TdmcpConfig;
  includeHighFrequency?: boolean;
  /** Where each event line goes; defaults to stdout. Overridable for tests. */
  write?: (line: string) => void;
  /** Inject a stream factory for tests; defaults to a real `TdEventStream`. */
  makeStream?: (args: { url: string; onEvent: TdEventHandler; includeHighFrequency: boolean }) => {
    start: () => void;
    close: () => void;
  };
  /** Resolve the returned promise when aborted; defaults to listening for SIGINT. */
  signal?: AbortSignal;
}

/**
 * Streams TouchDesigner bridge events to stdout as ndjson until interrupted.
 * Runs outside `runCli` because it is a long-lived stream, not a request/response.
 */
export function runWatch(opts: RunWatchOptions = {}): Promise<void> {
  const config = opts.config ?? loadConfig();
  const url = `${tdBaseUrl(config).replace(/^http/, "ws")}/`;
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const includeHighFrequency = opts.includeHighFrequency ?? false;
  const onEvent: TdEventHandler = (event) => write(JSON.stringify(event));
  const stream = opts.makeStream
    ? opts.makeStream({ url, onEvent, includeHighFrequency })
    : new TdEventStream({ url, onEvent, includeHighFrequency });
  stream.start();
  process.stderr.write(`Watching ${url} for TouchDesigner events (Ctrl-C to stop)…\n`);
  return new Promise<void>((resolveDone) => {
    const stop = () => {
      stream.close();
      resolveDone();
    };
    if (opts.signal) {
      if (opts.signal.aborted) return stop();
      opts.signal.addEventListener("abort", stop, { once: true });
    } else {
      process.once("SIGINT", stop);
    }
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  // `watch` is a long-lived stream, so it bypasses runCli's request/response model.
  if (argv[0] === "watch" && !wantsHelp) {
    await runWatch({ includeHighFrequency: argv.includes("--include-high-frequency") });
    return;
  }
  const result = await runCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) void main();
