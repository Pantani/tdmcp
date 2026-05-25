import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildToolContext } from "../server/context.js";
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
import { loadConfig } from "../utils/config.js";
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
  lines.push("  -h, --help        Show this help.", "");
  lines.push("Commands:");
  for (const [key, cmd] of Object.entries(COMMANDS)) {
    const tags = [cmd.mutates ? "mutates" : "", cmd.unsafe ? "unsafe" : ""]
      .filter(Boolean)
      .join(",");
    lines.push(`  ${key.padEnd(20)} ${cmd.summary}${tags ? `  [${tags}]` : ""}`);
  }
  lines.push("  schema <command>     Print a command's JSON Schema and metadata.");
  return lines.join("\n");
}

export interface RunCliOptions {
  /** Inject a context (used by tests); production builds one from env config. */
  makeCtx?: () => ToolContext;
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

  const ctx = opts.makeCtx
    ? opts.makeCtx()
    : buildToolContext(loadConfig(), { logger: silentLogger });

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

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) void main();
