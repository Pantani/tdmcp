import { z } from "zod";
import type { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const checkOperatorAvailabilitySchema = z.object({
  operator: z
    .string()
    .optional()
    .describe(
      "Optional single operator name/optype to check (e.g. 'noiseTOP' or 'Noise TOP'). Omit to reconcile the whole knowledge base against the live TouchDesigner.",
    ),
  include_kb_gap: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Also list creatable optypes the live TD exposes that the static knowledge base does not document (build/plugin drift).",
    ),
});
type CheckOperatorAvailabilityArgs = z.infer<typeof checkOperatorAvailabilitySchema>;

/** Normalize an operator name or optype to a comparable key: alphanumerics only,
 * lowercased. Reconciles the KB's display names ("Noise TOP", "Art-Net DAT")
 * with the live camelCase optypes ("noiseTOP", "artnetDAT"). */
function normKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface OperatorAvailability {
  name: string;
  optype: string;
  category: string;
  createable: boolean;
  deprecated: boolean;
}

function reconcile(
  kb: Array<{ name: string; category: string }>,
  liveByKey: Map<string, string>,
): OperatorAvailability[] {
  return kb.map((entry) => {
    const optype = liveByKey.get(normKey(entry.name));
    return {
      name: entry.name,
      optype: optype ?? "",
      category: entry.category,
      createable: optype !== undefined,
      deprecated: optype === undefined,
    };
  });
}

type OpTypesLive = Awaited<ReturnType<TouchDesignerClient["getOpTypes"]>>;
type Reconciled = ReturnType<typeof reconcile>;

/**
 * Single-operator lookup that the KB doesn't document (e.g. a brand-new plugin optype):
 * fall back to a direct live check by the given name.
 */
function singleOperatorFallback(
  operator: string,
  liveByKey: Map<string, string>,
  live: OpTypesLive,
) {
  const optype = liveByKey.get(normKey(operator));
  const summary = optype
    ? `${operator} is creatable in this TouchDesigner as ${optype} (not documented in the knowledge base).`
    : `${operator} is NOT creatable in this TouchDesigner and is not in the knowledge base.`;
  return jsonResult(summary, {
    operator,
    createable: optype !== undefined,
    optype: optype ?? null,
    in_knowledge_base: false,
    td_version: live.td_version ?? null,
    build: live.build ?? null,
  });
}

/** One-line summary of the reconciliation (single-operator vs whole-KB phrasing). */
function reconcileSummary(
  args: CheckOperatorAvailabilityArgs,
  reconciled: Reconciled,
  deprecatedCount: number,
  kbGapCount: number | undefined,
  live: OpTypesLive,
): string {
  if (args.operator) {
    const state = reconciled[0]?.createable ? "creatable" : "deprecated/unavailable";
    return `${args.operator}: ${state} in TD ${live.td_version ?? "?"} (build ${live.build ?? "?"}).`;
  }
  const gap = kbGapCount !== undefined ? `, ${kbGapCount} live-only (KB gap)` : "";
  return `Reconciled ${reconciled.length} knowledge-base operators against live TD ${live.td_version ?? "?"}: ${reconciled.length - deprecatedCount} creatable, ${deprecatedCount} deprecated/unavailable${gap}.`;
}

export async function checkOperatorAvailabilityImpl(
  ctx: ToolContext,
  args: CheckOperatorAvailabilityArgs,
) {
  return guardTd(
    () => ctx.client.getOpTypes(),
    (live) => {
      const liveByKey = new Map<string, string>();
      for (const optype of live.optypes) liveByKey.set(normKey(optype), optype);

      const kbAll = ctx.knowledge
        .listOperators()
        .map((s) => ({ name: s.name, category: s.category }));
      const kb = args.operator
        ? kbAll.filter((e) => normKey(e.name) === normKey(args.operator as string))
        : kbAll;

      const reconciled = reconcile(kb, liveByKey);
      if (args.operator && reconciled.length === 0) {
        return singleOperatorFallback(args.operator, liveByKey, live);
      }

      const deprecated = reconciled.filter((r) => r.deprecated);
      const kbKeys = new Set(kbAll.map((e) => normKey(e.name)));
      const kbGap = args.include_kb_gap
        ? live.optypes.filter((o) => !kbKeys.has(normKey(o))).sort()
        : undefined;

      const summary = reconcileSummary(args, reconciled, deprecated.length, kbGap?.length, live);
      return jsonResult(summary, {
        td_version: live.td_version ?? null,
        build: live.build ?? null,
        live_optype_count: live.count,
        checked: reconciled.length,
        createable_count: reconciled.length - deprecated.length,
        deprecated: deprecated.map((d) => ({ name: d.name, category: d.category })),
        ...(args.operator ? { operators: reconciled } : {}),
        ...(kbGap ? { kb_gap: kbGap } : {}),
      });
    },
  );
}

export const registerCheckOperatorAvailability: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "check_operator_availability",
    {
      title: "Check operator availability",
      description:
        "Reconcile the operator knowledge base against the RUNNING TouchDesigner's ground-truth creatable-optype list (GET /api/optypes). Flags which documented operators are actually creatable in this build vs deprecated/unavailable, and (optionally) which live optypes the knowledge base doesn't yet document. Pass a single operator name to check just that one. Survives TDMCP_BRIDGE_ALLOW_EXEC=0.",
      inputSchema: checkOperatorAvailabilitySchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => checkOperatorAvailabilityImpl(ctx, args),
  );
};
