import { friendlyTdError } from "../td-client/types.js";
import { createPanicImpl } from "../tools/layer2/createPanic.js";
import type { ToolContext } from "../tools/types.js";

/**
 * `tdmcp-agent panic` — the live-show "oh no" hotkey, exposed as a top-level CLI
 * verb. This is CLI ergonomics over an already-shipped mechanism: it does NOT
 * build the panic network (that's `create_panic`'s job); it locates an existing
 * panic COMP and flips its `Blackout` / `Freeze` toggle parameters.
 *
 * A panic COMP is detected by signature — a container whose parameters include
 * both `Blackout` and `Freeze` (the custom pars `create_panic` leaves). Auto-build
 * delegates to `createPanicImpl` so a global hotkey ALWAYS leaves a black output,
 * never an error.
 */

export type PanicSubVerb = "on" | "off" | "toggle" | "freeze" | "unfreeze" | "clear" | "status";

export interface PanicArgs {
  sub: PanicSubVerb;
  target?: string;
  autoBuild?: boolean;
  all?: boolean;
  json?: boolean;
  dryRun?: boolean;
  /** Parent COMP to scan when auto-detecting (default `/project1`). */
  scanRoot?: string;
}

export interface PanicTargetState {
  path: string;
  blackout: boolean;
  freeze: boolean;
}

export interface PanicReport {
  action: PanicSubVerb;
  targets: string[];
  previous_state: PanicTargetState[];
  new_state: PanicTargetState[];
  elapsed_ms: number;
  auto_built?: boolean;
  dry_run?: boolean;
}

export interface PanicResult {
  stdout: string;
  stderr: string;
  code: number;
  report?: PanicReport;
}

const SIGNATURE_PARS = ["Blackout", "Freeze"] as const;

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    return t === "1" || t === "true" || t === "on";
  }
  return false;
}

function readState(parameters: Record<string, unknown>, path: string): PanicTargetState {
  return {
    path,
    blackout: asBool(parameters.Blackout),
    freeze: asBool(parameters.Freeze),
  };
}

/** Does this node's parameters carry the panic-COMP signature? */
function hasSignature(parameters: Record<string, unknown>): boolean {
  return SIGNATURE_PARS.every((k) => Object.hasOwn(parameters, k));
}

/** Scan `scanRoot` for panic COMPs by parameter signature. Returns absolute paths. */
async function findPanicTargets(ctx: ToolContext, scanRoot: string): Promise<string[]> {
  const list = await ctx.client.getNodes(scanRoot);
  const found: string[] = [];
  for (const ref of list.nodes) {
    // Containers in TD have type `containerCOMP` (or `baseCOMP` from createSystemContainer).
    // We don't gate on type — any node with both signature pars is a panic COMP. The
    // detail fetch is cheap and only happens for `/project1`'s direct children (≤ ~50).
    try {
      const detail = await ctx.client.getNode(ref.path);
      if (hasSignature(detail.parameters)) found.push(detail.path);
    } catch {
      // Skip nodes the bridge can't introspect — they're not our panic COMP.
    }
  }
  return found;
}

/** Compute the parameter writes for a sub-verb given the current state. */
function writesFor(sub: PanicSubVerb, current: PanicTargetState): Record<string, number> | null {
  switch (sub) {
    case "on":
      return { Blackout: 1 };
    case "off":
      return { Blackout: 0 };
    case "toggle":
      return { Blackout: current.blackout ? 0 : 1 };
    case "freeze":
      return { Freeze: 1 };
    case "unfreeze":
      return { Freeze: 0 };
    case "clear":
      return { Blackout: 0, Freeze: 0 };
    case "status":
      return null;
  }
}

function describeTransition(before: PanicTargetState, after: PanicTargetState): string {
  const parts: string[] = [];
  if (before.blackout !== after.blackout) {
    parts.push(`blackout ${before.blackout ? 1 : 0}→${after.blackout ? 1 : 0}`);
  }
  if (before.freeze !== after.freeze) {
    parts.push(`freeze ${before.freeze ? 1 : 0}→${after.freeze ? 1 : 0}`);
  }
  return parts.join(", ");
}

function liveLabel(state: PanicTargetState): string {
  if (state.blackout) return "BLACKOUT";
  if (state.freeze) return "FROZEN";
  return "live";
}

function shortName(path: string): string {
  const segs = path.split("/");
  return segs[segs.length - 1] ?? path;
}

function renderHuman(args: PanicArgs, report: PanicReport): string {
  if (args.sub === "status") {
    return report.new_state
      .map(
        (s) =>
          `${shortName(s.path)}: blackout=${s.blackout ? "on" : "off"}  freeze=${
            s.freeze ? "on" : "off"
          }  (${liveLabel(s).toLowerCase()})`,
      )
      .join("\n");
  }
  if (args.dryRun) {
    return report.targets
      .map((p, i) => {
        const before = report.previous_state[i] ?? readState({}, p);
        return `${shortName(p)}: would ${args.sub} (current: ${liveLabel(before).toLowerCase()}) — dry-run, no change.`;
      })
      .join("\n");
  }
  return report.targets
    .map((p, i) => {
      const before = report.previous_state[i] ?? readState({}, p);
      const after = report.new_state[i] ?? before;
      const transition = describeTransition(before, after);
      if (args.sub === "clear") {
        return `${shortName(p)}: cleared (${transition || "no change"}) — live output restored.`;
      }
      if (args.sub === "on") {
        return `${shortName(p)}: BLACKOUT (was: ${liveLabel(before).toLowerCase()}) — output is black. Run \`tdmcp-agent panic clear\` to recover.`;
      }
      if (args.sub === "off") {
        return `${shortName(p)}: blackout off (${transition || "no change"}).`;
      }
      if (args.sub === "toggle") {
        return `${shortName(p)}: toggled (${transition || "no change"}).`;
      }
      if (args.sub === "freeze") {
        return `${shortName(p)}: FROZEN (${transition || "no change"}).`;
      }
      if (args.sub === "unfreeze") {
        return `${shortName(p)}: freeze off (${transition || "no change"}).`;
      }
      return `${shortName(p)}: ${args.sub} (${transition || "no change"}).`;
    })
    .join("\n");
}

/**
 * Drive a `panic` invocation against TD. Pure async function: takes a `ToolContext`
 * (so tests can pass an msw-backed client) and the parsed CLI args, returns a
 * CliResult-shaped payload plus a structured report.
 */
export async function runPanic(ctx: ToolContext, args: PanicArgs): Promise<PanicResult> {
  const t0 = Date.now();
  const scanRoot = args.scanRoot ?? "/project1";

  if (args.target && args.all) {
    return {
      stdout: "",
      stderr: "error: --target and --all are mutually exclusive.\n",
      code: 2,
    };
  }

  let targets: string[] = [];
  let autoBuilt = false;

  try {
    if (args.target) {
      targets = [args.target];
    } else {
      targets = await findPanicTargets(ctx, scanRoot);

      if (targets.length === 0) {
        if (args.autoBuild) {
          await createPanicImpl(ctx, {
            blackout: false,
            freeze: false,
            expose_controls: true,
            parent_path: scanRoot,
          });
          // After the build, rescan for the new signature-bearing COMP. This is the
          // simplest, shape-agnostic way to discover whatever path `createPanicImpl`
          // ended up using (it auto-numbers `panic1`, `panic2`, …).
          targets = await findPanicTargets(ctx, scanRoot);
          autoBuilt = true;
          if (targets.length === 0) {
            return {
              stdout: "",
              stderr: `error: --auto-build ran but no panic COMP was found under ${scanRoot}.\n`,
              code: 1,
            };
          }
        } else {
          return {
            stdout: "",
            stderr: `error: no panic COMP found under ${scanRoot}.\nhint: build one first (\`mcp tool create_panic\`), pass --target <path>, or re-run with --auto-build.\n`,
            code: 3,
          };
        }
      } else if (targets.length > 1 && !args.all) {
        const list = targets.map((p) => `  ${p}`).join("\n");
        return {
          stdout: "",
          stderr: `error: found ${targets.length} panic COMPs — pick one with --target <path> or use --all:\n${list}\n`,
          code: 2,
        };
      }
    }

    // Read current state for every target.
    const previous: PanicTargetState[] = [];
    for (const path of targets) {
      const detail = await ctx.client.getNode(path);
      previous.push(readState(detail.parameters, path));
    }

    // Compute and apply writes.
    const nextState: PanicTargetState[] = [];
    for (let i = 0; i < targets.length; i++) {
      const path = targets[i] ?? "";
      const before = previous[i] ?? readState({}, path);
      const writes = writesFor(args.sub, before);
      if (!writes || args.dryRun) {
        nextState.push(before);
        continue;
      }
      const updated = await ctx.client.updateNodeParameters(path, writes);
      nextState.push(readState(updated.parameters, path));
    }

    const report: PanicReport = {
      action: args.sub,
      targets,
      previous_state: previous,
      new_state: nextState,
      elapsed_ms: Date.now() - t0,
      ...(autoBuilt ? { auto_built: true } : {}),
      ...(args.dryRun ? { dry_run: true } : {}),
    };

    const stdout = args.json ? `${JSON.stringify(report)}\n` : `${renderHuman(args, report)}\n`;
    return { stdout, stderr: "", code: 0, report };
  } catch (err) {
    return {
      stdout: "",
      stderr: `error: ${friendlyTdError(err)}\n`,
      code: 1,
    };
  }
}
