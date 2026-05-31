import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const manageComponentStorageSchema = z.object({
  path: z.string().describe("Full path of the COMP whose storage dict to operate on."),
  action: z
    .enum(["list", "get", "set", "delete"])
    .describe(
      "'list' returns all keys+values; 'get' reads one key; 'set' writes one key; 'delete' removes one key.",
    ),
  key: z.string().optional().describe("Storage key. Required for get/set/delete; omit for list."),
  value: z
    .unknown()
    .optional()
    .describe(
      "Value to store under 'key'. Required for set. Must be JSON-serialisable (string, number, bool, list, dict, null).",
    ),
});

type ManageComponentStorageArgs = z.infer<typeof manageComponentStorageSchema>;

interface StorageReport {
  ok: boolean;
  data?: Record<string, unknown> | null;
  error?: string;
}

const STORAGE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
try:
    c = op(_p["path"])
    if c is None:
        report = {"ok": False, "error": "operator not found: " + str(_p["path"])}
    elif not hasattr(c, "store"):
        report = {"ok": False, "error": "operator is not a COMP (no .store method): " + str(_p["path"])}
    else:
        action = _p["action"]
        key = _p.get("key")
        value = _p.get("value")

        if action == "list":
            try:
                raw = dict(c.storage)
            except Exception:
                raw = {k: c.storage[k] for k in c.storage}
            # Gracefully skip non-serialisable values
            safe = {}
            warnings = []
            for k, v in raw.items():
                try:
                    json.dumps(v)
                    safe[k] = v
                except (TypeError, ValueError):
                    warnings.append(k)
            report = {"ok": True, "data": safe}
            if warnings:
                report["warnings"] = warnings
        elif action == "get":
            if key not in c.storage:
                report = {"ok": False, "error": "key not found: " + repr(key)}
            else:
                report = {"ok": True, "data": {key: c.storage[key]}}
        elif action == "set":
            c.store(key, value)
            report = {"ok": True, "data": {key: value}}
        elif action == "delete":
            try:
                c.unstore(key)
            except Exception:
                pass
            report = {"ok": True, "data": None}
        else:
            report = {"ok": False, "error": "unknown action: " + repr(action)}
except Exception as e:
    report = {"ok": False, "error": traceback.format_exc()}

result = json.dumps(report)
`;

export function buildManageComponentStorageScript(args: ManageComponentStorageArgs): string {
  return buildPayloadScript(STORAGE_SCRIPT, {
    path: args.path,
    action: args.action,
    key: args.key ?? null,
    value: args.value ?? null,
  });
}

export async function manageComponentStorageImpl(
  ctx: ToolContext,
  args: ManageComponentStorageArgs,
) {
  // TS-level validation guards
  if (args.action === "get" || args.action === "set" || args.action === "delete") {
    if (!args.key) {
      return errorResult(`key is required for ${args.action}`);
    }
  }
  if (args.action === "set") {
    if (args.value === undefined) {
      return errorResult("value is required for set");
    }
    // JSON-serialisability check
    try {
      JSON.parse(JSON.stringify(args.value));
    } catch {
      return errorResult("value must be JSON-serialisable");
    }
  }

  const script = buildManageComponentStorageScript(args);
  let stdout: string;
  try {
    const response = await ctx.client.executePythonScript(script);
    stdout = response.stdout ?? "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Bridge error: ${msg}`);
  }

  const report = parsePythonReport<StorageReport>(stdout);
  if (!report.ok) {
    return errorResult(report.error ?? "Unknown bridge error");
  }

  return structuredResult(
    `manage_component_storage(${args.action}) on ${args.path}` +
      (args.key ? ` key=${args.key}` : ""),
    {
      path: args.path,
      action: args.action,
      ...(args.key !== undefined ? { key: args.key } : {}),
      data: report.data ?? null,
    },
  );
}

export const registerManageComponentStorage: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "manage_component_storage",
    {
      title: "Manage Component Storage",
      description:
        "CRUD operations on a COMP operator's .storage dictionary. Actions: list (all keys+values), get (one key), set (write a key), delete (remove a key). No operators are created; the target COMP must already exist.",
      inputSchema: manageComponentStorageSchema.shape,
    },
    (args) => manageComponentStorageImpl(ctx, args),
  );
