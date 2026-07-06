import { z } from "zod";
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

export async function checkOperatorAvailabilityImpl(
  ctx: ToolContext,
  args: CheckOperatorAvailabilityArgs,
) {
  return guardTd(
    () => ctx.client.getOpTypes(),
    (live) => {
      const liveByKey = new Map<string, string>();
      for (const optype of live.optypes) liveByKey.set(normKey(optype), optype);

      const kbAll = ctx.knowledge.listOperators().map((s) => ({
        name: s.name,
        category: s.category,
      }));
      const kb = args.operator
        ? kbAll.filter((e) => normKey(e.name) === normKey(args.operator as string))
        : kbAll;

      const reconciled = reconcile(kb, liveByKey);

      // Single-operator lookup: the KB may not carry it at all (e.g. a brand-new
      // plugin optype), so fall back to a direct live check by the given name.
      if (args.operator && reconciled.length === 0) {
        const optype = liveByKey.get(normKey(args.operator));
        const summary = optype
          ? `${args.operator} is creatable in this TouchDesigner as ${optype} (not documented in the knowledge base).`
          : `${args.operator} is NOT creatable in this TouchDesigner and is not in the knowledge base.`;
        return jsonResult(summary, {
          operator: args.operator,
          createable: optype !== undefined,
          optype: optype ?? null,
          in_knowledge_base: false,
          td_version: live.td_version ?? null,
          build: live.build ?? null,
        });
      }

      const deprecated = reconciled.filter((r) => r.deprecated);
      const kbKeys = new Set(kbAll.map((e) => normKey(e.name)));
      const kbGap = args.include_kb_gap
        ? live.optypes.filter((o) => !kbKeys.has(normKey(o))).sort()
        : undefined;

      const summary = args.operator
        ? `${args.operator}: ${reconciled[0]?.createable ? "creatable" : "deprecated/unavailable"} in TD ${live.td_version ?? "?"} (build ${live.build ?? "?"}).`
        : `Reconciled ${reconciled.length} knowledge-base operators against live TD ${live.td_version ?? "?"}: ${reconciled.length - deprecated.length} creatable, ${deprecated.length} deprecated/unavailable${kbGap ? `, ${kbGap.length} live-only (KB gap)` : ""}.`;

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
