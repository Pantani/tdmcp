import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getOperatorWorkflowGuideSchema = z.object({
  operator: z.string().min(1).describe("Operator name, display name, or slug to look up."),
  include_examples: z
    .boolean()
    .default(true)
    .describe("Include Python examples, expressions, and generated usage patterns."),
  next_limit: z.coerce
    .number()
    .int()
    .positive()
    .max(25)
    .default(8)
    .describe("Maximum number of next-operator suggestions to return."),
});
type GetOperatorWorkflowGuideArgs = z.input<typeof getOperatorWorkflowGuideSchema>;

export const getOperatorWorkflowGuideOutputSchema = z.object({
  operator: z.string().describe("The operator string from the request."),
  found: z.boolean().describe("True when the embedded knowledge base has a workflow guide."),
  guide: z.unknown().optional().describe("Operator connection guide, when found."),
  examples: z.unknown().optional().describe("Operator examples, when requested and available."),
  nextOperators: z.array(z.unknown()).describe("Suggested downstream operators."),
  suggestions: z.array(z.string()).describe("Candidate operator ids when no exact guide is found."),
});

export function getOperatorWorkflowGuideImpl(
  ctx: ToolContext,
  rawArgs: GetOperatorWorkflowGuideArgs,
): CallToolResult {
  const parsed = getOperatorWorkflowGuideSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid get_operator_workflow_guide input.", {
      issues: parsed.error.issues,
    });
  }

  const args = parsed.data;
  try {
    const guide = ctx.knowledge.getOperatorConnections(args.operator);

    if (!guide) {
      const suggestions = ctx.knowledge
        .searchOperatorConnectionGuides(args.operator, 5)
        .map((suggestion) => suggestion.id);
      return structuredResult(`No workflow guide found for "${args.operator}".`, {
        operator: args.operator,
        found: false,
        nextOperators: [],
        suggestions,
      });
    }

    const examples = args.include_examples
      ? ctx.knowledge.getOperatorExamples(args.operator)
      : undefined;
    return structuredResult(`Workflow guide for "${args.operator}".`, {
      operator: args.operator,
      found: true,
      guide,
      examples,
      nextOperators: ctx.knowledge.suggestNextOperators(args.operator, args.next_limit),
      suggestions: [],
    });
  } catch (err) {
    return errorResult(`Failed to read workflow guide for "${args.operator}".`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerGetOperatorWorkflowGuide: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_operator_workflow_guide",
    {
      title: "Get operator workflow guide",
      description:
        "Read-only: return an embedded TouchDesigner operator workflow guide with common inputs, outputs, examples, and next-operator suggestions. For unknown operators, returns candidate guide ids instead of failing.",
      inputSchema: getOperatorWorkflowGuideSchema.shape,
      outputSchema: getOperatorWorkflowGuideOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => getOperatorWorkflowGuideImpl(ctx, args),
  );
};
