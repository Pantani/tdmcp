import { z } from "zod";
import { memoryNoteRel, mergeMemoryFrontmatter, mergeStyleMemory } from "../../vault/memoryNote.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

/**
 * `learn_conventions` walks a live TouchDesigner subtree, infers the artist's
 * house conventions (naming, color tags, container shapes, recurring param
 * values, layout direction), and persists them to the shared memory_note
 * (`Memory/conventions.md`) — and, when confident, into the typed style note.
 *
 * Read-only on the TD side. Writes only go to the configured Obsidian vault
 * via the foundation helpers; no schema redefinition.
 */
export const learnConventionsSchema = z.object({
  scope_path: z
    .string()
    .default("/project1")
    .describe("Root COMP whose subtree is sampled. Defaults to /project1."),
  observe: z
    .array(z.enum(["naming", "colors", "topology", "params"]))
    .default(["naming", "colors", "topology", "params"])
    .describe("Which convention families to extract."),
  max_nodes: z
    .number()
    .int()
    .min(10)
    .max(2000)
    .default(500)
    .describe("Cap on nodes walked (BFS, depth-unlimited until cap)."),
  min_support: z
    .number()
    .int()
    .min(2)
    .default(3)
    .describe("A pattern must appear at least this many times to be recorded."),
  dry_run: z
    .boolean()
    .default(false)
    .describe("If true, return the extracted conventions but do NOT write the vault note."),
  also_patch_style_memory: z
    .boolean()
    .default(true)
    .describe("If a confident naming/layout signal is found, also merge it into Memory/style.md."),
});

export type LearnConventionsArgs = z.infer<typeof learnConventionsSchema>;

// ---------------------------------------------------------------------------
// Python payload — single bridge round-trip; reads only
// ---------------------------------------------------------------------------

const LEARN_CONVENTIONS_SCRIPT = `
import json, base64, traceback
_payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"scope_path": _payload.get("scope_path", ""), "scanned": 0, "rows": [], "warnings": []}
try:
    _root = op(_payload["scope_path"])
    if _root is None:
        report["fatal"] = "Scope COMP not found: " + str(_payload["scope_path"])
    else:
        _max = int(_payload.get("max_nodes", 500))
        _seen = set()
        _rows = []
        _depth = 1
        _hit_cap = False
        # Expand BFS by depth until cap.
        while True:
            try:
                _kids = _root.findChildren(depth=_depth)
            except Exception:
                _kids = []
            _new = 0
            for _n in _kids:
                try:
                    _p = _n.path
                except Exception:
                    continue
                if _p in _seen:
                    continue
                _seen.add(_p)
                _new += 1
                if len(_rows) >= _max:
                    _hit_cap = True
                    break
                _row = {"path": _p}
                try:
                    _row["name"] = _n.name
                except Exception:
                    _row["name"] = ""
                try:
                    _row["type"] = _n.type
                except Exception:
                    _row["type"] = ""
                try:
                    _row["family"] = _n.family
                except Exception:
                    _row["family"] = ""
                try:
                    _c = _n.color
                    if _c is not None:
                        _row["color"] = [float(_c[0]), float(_c[1]), float(_c[2])]
                except Exception:
                    pass
                try:
                    _row["nodeX"] = float(_n.nodeX)
                except Exception:
                    pass
                try:
                    _row["nodeY"] = float(_n.nodeY)
                except Exception:
                    pass
                try:
                    _par = _n.parent()
                    if _par is not None:
                        _row["parent_path"] = _par.path
                except Exception:
                    pass
                # Param snapshot for the most-used customizable params per family.
                try:
                    _pars = []
                    for _pr in _n.customPars:
                        try:
                            _pars.append({"name": _pr.name, "value": _pr.eval()})
                        except Exception:
                            continue
                    if _pars:
                        _row["custom_pars"] = _pars
                except Exception:
                    pass
                # A handful of common built-in pars worth tracking (best-effort).
                try:
                    _common = ["opacity", "brightness1", "gain", "level", "blur", "speed"]
                    _bi = {}
                    for _name in _common:
                        try:
                            _pr = getattr(_n.par, _name, None)
                            if _pr is None:
                                continue
                            _v = _pr.eval()
                            if isinstance(_v, (int, float, str, bool)):
                                _bi[_name] = _v
                        except Exception:
                            continue
                    if _bi:
                        _row["builtin_pars"] = _bi
                except Exception:
                    pass
                _rows.append(_row)
            if _hit_cap:
                report["warnings"].append("max_nodes reached")
                break
            if _new == 0:
                break
            _depth += 1
            if _depth > 64:
                break
        report["rows"] = _rows
        report["scanned"] = len(_rows)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
result = json.dumps(report)
print(result)
`;

export function buildLearnConventionsScript(payload: object): string {
  return buildPayloadScript(LEARN_CONVENTIONS_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Pure extraction
// ---------------------------------------------------------------------------

export interface ConventionsRow {
  path: string;
  name?: string;
  type?: string;
  family?: string;
  color?: [number, number, number];
  nodeX?: number;
  nodeY?: number;
  parent_path?: string;
  custom_pars?: Array<{ name: string; value: unknown }>;
  builtin_pars?: Record<string, unknown>;
}

export interface ConventionsReport {
  scope_path: string;
  scanned: number;
  rows: ConventionsRow[];
  warnings: string[];
  fatal?: string;
}

export interface NamingFinding {
  case?: "camelCase" | "snake_case" | "kebab-case" | "lowercase" | "MIXED";
  prefixes_by_family: Record<string, Record<string, number>>;
}

export interface ColorTag {
  rgb: [number, number, number];
  roles: string[];
  count: number;
}

export interface ContainerShape {
  archetype: "generator" | "effect" | "control" | "output" | "other";
  child_count_range: [number, number];
  typical_children: string[];
  count: number;
}

export interface ParamDefault {
  type: string;
  param: string;
  value: unknown;
  support: number;
}

export interface ConventionsExtract {
  scope_path: string;
  sample_size: number;
  naming?: NamingFinding;
  naming_label?: string;
  color_tags?: ColorTag[];
  container_shapes?: ContainerShape[];
  param_defaults?: ParamDefault[];
  layout?: string;
  warnings: string[];
}

function stripTrailingDigits(name: string): string {
  return name.replace(/[_-]?\d+$/, "");
}

function detectCase(
  name: string,
): "camelCase" | "snake_case" | "kebab-case" | "lowercase" | "MIXED" {
  if (name.includes("_")) return "snake_case";
  if (name.includes("-")) return "kebab-case";
  if (/[a-z][A-Z]/.test(name)) return "camelCase";
  if (/^[a-z0-9]+$/.test(name)) return "lowercase";
  return "MIXED";
}

function tokenizeFirstPrefix(name: string): string {
  if (name.includes("_")) return name.split("_")[0] ?? "";
  if (name.includes("-")) return name.split("-")[0] ?? "";
  // camel-boundary
  const m = /^([a-z]+)[A-Z]/.exec(name);
  if (m?.[1]) return m[1];
  return name;
}

function familyOf(row: ConventionsRow): string {
  if (row.family) return row.family.toUpperCase();
  const t = (row.type ?? "").toLowerCase();
  if (t.endsWith("top")) return "TOP";
  if (t.endsWith("chop")) return "CHOP";
  if (t.endsWith("sop")) return "SOP";
  if (t.endsWith("dat")) return "DAT";
  if (t.endsWith("mat")) return "MAT";
  if (t.endsWith("comp")) return "COMP";
  return "OTHER";
}

function extractNaming(rows: ConventionsRow[], minSupport: number): NamingFinding {
  const caseCounts: Record<string, number> = {};
  const prefixesByFamily: Record<string, Record<string, number>> = {};
  let total = 0;
  for (const r of rows) {
    const name = r.name ?? "";
    if (!name) continue;
    total += 1;
    const c = detectCase(name);
    caseCounts[c] = (caseCounts[c] ?? 0) + 1;
    const stripped = stripTrailingDigits(name);
    const prefix = tokenizeFirstPrefix(stripped);
    if (!prefix) continue;
    const fam = familyOf(r);
    if (!prefixesByFamily[fam]) prefixesByFamily[fam] = {};
    const bucket = prefixesByFamily[fam];
    bucket[prefix] = (bucket[prefix] ?? 0) + 1;
  }
  // Filter prefixes by support
  const filteredPrefixes: Record<string, Record<string, number>> = {};
  for (const [fam, counts] of Object.entries(prefixesByFamily)) {
    const kept: Record<string, number> = {};
    for (const [pfx, n] of Object.entries(counts)) {
      if (n >= minSupport) kept[pfx] = n;
    }
    if (Object.keys(kept).length > 0) filteredPrefixes[fam] = kept;
  }
  // Majority case (>=60%)
  let bestCase: NamingFinding["case"];
  if (total > 0) {
    let bestKey = "";
    let bestN = 0;
    for (const [k, v] of Object.entries(caseCounts)) {
      if (v > bestN) {
        bestN = v;
        bestKey = k;
      }
    }
    if (bestN / total >= 0.6) bestCase = bestKey as NamingFinding["case"];
  }
  return { case: bestCase, prefixes_by_family: filteredPrefixes };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function extractColors(rows: ConventionsRow[], minSupport: number): ColorTag[] {
  const buckets = new Map<
    string,
    { rgb: [number, number, number]; roles: Map<string, number>; count: number }
  >();
  for (const r of rows) {
    if (!r.color) continue;
    const [a, b, c] = r.color;
    const rgb: [number, number, number] = [round2(a), round2(b), round2(c)];
    const key = rgb.join(",");
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { rgb, roles: new Map(), count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const fam = familyOf(r);
    const role = `${fam}/${r.type ?? "?"}`;
    bucket.roles.set(role, (bucket.roles.get(role) ?? 0) + 1);
  }
  const out: ColorTag[] = [];
  for (const b of buckets.values()) {
    if (b.count < minSupport) continue;
    const roles = [...b.roles.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
    out.push({ rgb: b.rgb, roles, count: b.count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function archetypeFromChildren(types: string[]): ContainerShape["archetype"] {
  const lower = types.map((t) => t.toLowerCase());
  if (lower.length > 0 && lower.every((t) => t === "outtop")) return "output";
  if (lower.some((t) => t.includes("panel") || t === "buttoncomp" || t === "slidercomp"))
    return "control";
  if (lower.some((t) => t.startsWith("feedback") || t === "noisetop" || t === "ramptop"))
    return "generator";
  if (lower.some((t) => t === "blurtop" || t === "leveltop" || t === "compositetop"))
    return "effect";
  return "other";
}

function extractContainerShapes(
  rows: ConventionsRow[],
  scopePath: string,
  minSupport: number,
): ContainerShape[] {
  // Children grouped by parent path.
  const byParent = new Map<string, ConventionsRow[]>();
  for (const r of rows) {
    if (!r.parent_path) continue;
    const arr = byParent.get(r.parent_path) ?? [];
    arr.push(r);
    byParent.set(r.parent_path, arr);
  }
  // Identify depth-1 COMP children of scope_path.
  const depth1Comps = rows.filter(
    (r) => r.parent_path === scopePath && (r.family === "COMP" || /comp$/i.test(r.type ?? "")),
  );
  // Cluster by (rounded child_count bucket, top-3 child types).
  const clusters = new Map<string, { types: string[]; counts: number[]; count: number }>();
  for (const comp of depth1Comps) {
    const kids = byParent.get(comp.path) ?? [];
    if (kids.length === 0) continue;
    const typeCounts = new Map<string, number>();
    for (const k of kids) {
      const t = k.type ?? "";
      if (!t) continue;
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
    const top3 = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);
    const bucket = Math.max(1, Math.round(kids.length / 3) * 3);
    const key = `${bucket}:${top3.join(",")}`;
    let cl = clusters.get(key);
    if (!cl) {
      cl = { types: top3, counts: [], count: 0 };
      clusters.set(key, cl);
    }
    cl.counts.push(kids.length);
    cl.count += 1;
  }
  const out: ContainerShape[] = [];
  for (const cl of clusters.values()) {
    if (cl.count < minSupport) continue;
    const min = Math.min(...cl.counts);
    const max = Math.max(...cl.counts);
    out.push({
      archetype: archetypeFromChildren(cl.types),
      child_count_range: [min, max],
      typical_children: cl.types,
      count: cl.count,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function extractParamDefaults(rows: ConventionsRow[], minSupport: number): ParamDefault[] {
  const tally = new Map<string, { type: string; param: string; value: unknown; support: number }>();
  for (const r of rows) {
    const type = r.type ?? "";
    if (!type) continue;
    const pars: Array<{ name: string; value: unknown }> = [];
    if (r.builtin_pars) {
      for (const [name, value] of Object.entries(r.builtin_pars)) {
        pars.push({ name, value });
      }
    }
    if (r.custom_pars) pars.push(...r.custom_pars);
    for (const p of pars) {
      if (
        typeof p.value !== "number" &&
        typeof p.value !== "string" &&
        typeof p.value !== "boolean"
      )
        continue;
      const key = `${type}|${p.name}|${JSON.stringify(p.value)}`;
      const existing = tally.get(key);
      if (existing) {
        existing.support += 1;
      } else {
        tally.set(key, { type, param: p.name, value: p.value, support: 1 });
      }
    }
  }
  const out = [...tally.values()].filter((x) => x.support >= minSupport);
  out.sort((a, b) => b.support - a.support);
  return out.slice(0, 20);
}

function extractLayout(rows: ConventionsRow[]): string | undefined {
  // Per parent: look at children with both nodeX and nodeY.
  const byParent = new Map<string, ConventionsRow[]>();
  for (const r of rows) {
    if (!r.parent_path || r.nodeX === undefined || r.nodeY === undefined) continue;
    const arr = byParent.get(r.parent_path) ?? [];
    arr.push(r);
    byParent.set(r.parent_path, arr);
  }
  const votes: Record<string, number> = {};
  for (const kids of byParent.values()) {
    if (kids.length < 2) continue;
    const xs = kids.map((k) => k.nodeX as number);
    const ys = kids.map((k) => k.nodeY as number);
    const dx = Math.max(...xs) - Math.min(...xs);
    const dy = Math.max(...ys) - Math.min(...ys);
    // We can determine the dominant axis from the bounding box, but not
    // direction: sorting by coordinate then re-checking the same coordinate is
    // a tautology. Collapse to axis-only labels.
    const dir = dx >= dy ? "horizontal" : "vertical";
    votes[dir] = (votes[dir] ?? 0) + 1;
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [k, v] of Object.entries(votes)) {
    if (v > bestN) {
      bestN = v;
      best = k;
    }
  }
  return best;
}

export function extractConventions(
  report: ConventionsReport,
  args: Pick<LearnConventionsArgs, "observe" | "min_support" | "scope_path">,
): ConventionsExtract {
  const out: ConventionsExtract = {
    scope_path: report.scope_path || args.scope_path,
    sample_size: report.scanned,
    warnings: [...report.warnings],
  };
  const obs = new Set(args.observe);
  if (obs.has("naming")) {
    const n = extractNaming(report.rows, args.min_support);
    out.naming = n;
    if (n.case) out.naming_label = n.case;
  }
  if (obs.has("colors")) {
    out.color_tags = extractColors(report.rows, args.min_support);
  }
  if (obs.has("topology")) {
    out.container_shapes = extractContainerShapes(
      report.rows,
      report.scope_path || args.scope_path,
      args.min_support,
    );
  }
  if (obs.has("params")) {
    out.param_defaults = extractParamDefaults(report.rows, args.min_support);
  }
  const layout = extractLayout(report.rows);
  if (layout) out.layout = layout;
  return out;
}

function buildSummaryBody(extract: ConventionsExtract): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`## Conventions learned ${today}`];
  lines.push(`- Naming: ${extract.naming_label ?? "—"} (sample ${extract.sample_size} node(s))`);
  lines.push(`- Layout: ${extract.layout ?? "—"}`);
  lines.push(`- Color tags: ${extract.color_tags?.length ?? 0}`);
  lines.push(`- Container shapes: ${extract.container_shapes?.length ?? 0}`);
  lines.push(`- Param defaults: ${extract.param_defaults?.length ?? 0}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export const CONVENTIONS_TOPIC = "conventions";

export async function learnConventionsImpl(ctx: ToolContext, args: LearnConventionsArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  return guardTd(
    async () => {
      const script = buildLearnConventionsScript({
        scope_path: args.scope_path,
        max_nodes: args.max_nodes,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ConventionsReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`learn_conventions failed: ${report.fatal}`, report);
      }
      const extract = extractConventions(report, args);

      if (!args.dry_run) {
        const patch: Record<string, unknown> = {
          scope_path: extract.scope_path,
          sample_size: extract.sample_size,
          tags: ["conventions", "learned"],
        };
        if (extract.naming) {
          const namingOut: Record<string, unknown> = {
            prefixes_by_family: extract.naming.prefixes_by_family,
          };
          if (extract.naming.case) namingOut.case = extract.naming.case;
          patch.naming = namingOut;
        }
        if (extract.color_tags) patch.color_tags = extract.color_tags;
        if (extract.container_shapes) patch.container_shapes = extract.container_shapes;
        if (extract.param_defaults) patch.param_defaults = extract.param_defaults;
        if (extract.layout) patch.layout = extract.layout;
        mergeMemoryFrontmatter(vault, CONVENTIONS_TOPIC, patch, buildSummaryBody(extract));

        if (args.also_patch_style_memory) {
          const stylePatch: { naming?: string; layout?: string } = {};
          if (extract.naming_label) stylePatch.naming = extract.naming_label;
          if (extract.layout) stylePatch.layout = extract.layout;
          if (stylePatch.naming || stylePatch.layout) {
            mergeStyleMemory(vault, stylePatch);
          }
        }
      }

      const noteRel = memoryNoteRel(CONVENTIONS_TOPIC);
      const summary = args.dry_run
        ? `Extracted conventions from ${extract.sample_size} node(s) under ${extract.scope_path} (dry run — no vault writes).`
        : `Learned conventions from ${extract.sample_size} node(s) under ${extract.scope_path} → ${noteRel}.`;
      return jsonResult(summary, {
        note: noteRel,
        wrote_note: !args.dry_run,
        wrote_style_memory:
          !args.dry_run &&
          args.also_patch_style_memory &&
          (Boolean(extract.naming_label) || Boolean(extract.layout)),
        conventions: extract,
      });
    },
  );
}

export const registerLearnConventions: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "learn_conventions",
    {
      title: "Learn the artist's house conventions from a live TD subtree",
      description:
        "Walks a TouchDesigner subtree under `scope_path` (read-only), extracts naming/" +
        "colour/topology/parameter conventions, and writes the findings to the shared " +
        "Memory/conventions.md note (and, when confident, merges naming/layout into " +
        "Memory/style.md). Pure observation: no TD mutations. Requires TDMCP_VAULT_PATH.",
      inputSchema: learnConventionsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => learnConventionsImpl(ctx, args),
  );
};
