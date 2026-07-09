import {
  showPreflightReportImpl,
  showPreflightReportOutputSchema,
  showPreflightReportSchema,
} from "../showPreflightReportCore.js";
import type { ToolRegistrar } from "../types.js";

export { showPreflightReportImpl, showPreflightReportOutputSchema, showPreflightReportSchema };

export const registerShowPreflightReport: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "show_preflight_report",
    {
      title: "Show preflight report",
      description:
        "Read-only pre-show check: bridge reachability, node errors, topology, cook-time budget, GPU/display topology and perform-mode status in one PASS/UNVERIFIED/WARN/FAIL report. Use before rehearsals or venue handoff to see what is safe, unverified, suspicious, or failing without mutating the project.",
      inputSchema: showPreflightReportSchema.shape,
      outputSchema: showPreflightReportOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => showPreflightReportImpl(ctx, args),
  );
};
