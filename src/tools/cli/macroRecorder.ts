/**
 * `macro_recorder` — start/stop/list/load tool calls captured to a portable
 * `MacroRecord` JSON file. Replay ships in wave 5 as `run_macro_script`.
 */
import { z } from "zod";
import {
  defaultMacroFile,
  ensureDir,
  getMacroRecorder,
  isValidMacroName,
  listMacros,
  readMacro,
  resolveMacroFile,
  resolveMacrosDir,
  writeMacro,
} from "../../automation/macroSchema.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const macroRecorderSchema = z.object({
  action: z.enum(["start", "stop", "list", "load"]),
  name: z.string().min(1).max(80).optional(),
  file: z.string().optional(),
  redactSensitive: z.boolean().default(true),
  allowUnsafeRecording: z
    .boolean()
    .default(false)
    .describe("Required when redactSensitive=false because raw scripts/secrets may be persisted."),
});

export type MacroRecorderArgs = z.infer<typeof macroRecorderSchema>;

export async function macroRecorderImpl(_ctx: ToolContext, args: MacroRecorderArgs) {
  const dir = resolveMacrosDir();
  const recorder = getMacroRecorder();

  if (args.redactSensitive === false && args.allowUnsafeRecording !== true) {
    return errorResult(
      "`allowUnsafeRecording=true` is required when `redactSensitive=false`; otherwise raw scripts or secrets may be written to disk.",
    );
  }

  if (args.action === "start") {
    if (!args.name) return errorResult("`name` is required for action=start");
    if (!isValidMacroName(args.name)) {
      return errorResult("`name` must match [A-Za-z0-9_-]+ and be 1–80 chars");
    }
    const r = recorder.start({ name: args.name, redactSensitive: args.redactSensitive });
    if (!r.ok) return errorResult(r.error);
    return structuredResult(`recording started: ${args.name}`, {
      status: "recording",
      name: args.name,
    });
  }

  if (args.action === "stop") {
    const r = recorder.stop({ redactSensitive: args.redactSensitive });
    if (!r.ok) return errorResult(r.error);
    const { name, entryCount, record } = r.result;
    const file =
      args.file !== undefined ? resolveMacroFile(args.file, dir) : defaultMacroFile(name, dir);
    try {
      await writeMacro(file, record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`failed to write macro: ${msg}`);
    }
    return structuredResult(`recording stopped: ${name} (${entryCount} entries)`, {
      status: "stopped",
      name,
      file,
      entry_count: entryCount,
    });
  }

  if (args.action === "list") {
    try {
      await ensureDir(dir);
      const macros = await listMacros(dir);
      return structuredResult(`${macros.length} macro(s) in ${dir}`, {
        status: "listed",
        macros,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`failed to list macros: ${msg}`);
    }
  }

  // action === "load"
  if (!args.file) return errorResult("`file` is required for action=load");
  const file = resolveMacroFile(args.file, dir);
  try {
    const record = await readMacro(file);
    return structuredResult(`loaded macro: ${record.name} (${record.entries.length} entries)`, {
      status: "loaded",
      file,
      record,
    });
  } catch (err) {
    if (err && typeof err === "object" && "issues" in err) {
      const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> })
        .issues;
      const summary = issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
      return errorResult(`invalid macro file: ${summary}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`failed to load macro: ${msg}`);
  }
}

export const registerMacroRecorder: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "macro_recorder",
    {
      title: "Macro recorder",
      description:
        "Record the sequence of MCP tool calls to a portable JSON macro file. Actions: start | stop | list | load. Replay ships separately as `run_macro_script`.",
      inputSchema: macroRecorderSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => macroRecorderImpl(ctx, args),
  );
};
