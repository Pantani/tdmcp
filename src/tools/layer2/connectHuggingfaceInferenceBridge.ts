import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectHuggingfaceInferenceBridgeSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Hugging Face scaffold."),
  name: z.string().default("huggingface_inference_bridge").describe("Generated baseCOMP name."),
  endpoint_url: z.string().default("https://api-inference.huggingface.co/models/model-id"),
  task: z
    .enum(["text_to_image", "image_to_image", "audio_to_text", "text_generation", "embeddings"])
    .default("text_to_image"),
  token_env_name: z.string().default("HF_TOKEN"),
  input_slot_count: z.coerce.number().int().min(1).max(64).default(4),
  output_mode: z.enum(["image", "audio", "text", "json"]).default("image"),
  active: z.boolean().default(false),
});

type ConnectHuggingfaceInferenceBridgeArgs = z.infer<
  typeof connectHuggingfaceInferenceBridgeSchema
>;

function inputRows(args: ConnectHuggingfaceInferenceBridgeArgs): string[][] {
  const rows = [["slot", "task", "payload_hint"]];
  for (let index = 1; index <= args.input_slot_count; index += 1) {
    rows.push([`input_${index}`, args.task, "text|file path|adapter reference"]);
  }
  return rows;
}

function outputRows(args: ConnectHuggingfaceInferenceBridgeArgs): string[][] {
  return [
    ["output", "mode", "operator_action"],
    ["result", args.output_mode, "parse response and route to media/text adapter"],
    ["metadata", "json", "store model, latency, and prompt hash"],
  ];
}

export async function connectHuggingfaceInferenceBridgeImpl(
  ctx: ToolContext,
  args: ConnectHuggingfaceInferenceBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "huggingface_inference_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        endpoint_url: args.endpoint_url,
        task: args.task,
        token_env_name: args.token_env_name,
        input_slot_count: args.input_slot_count,
        output_mode: args.output_mode,
        active: args.active,
      },
      warnings: [
        "No Hugging Face token is stored in this scaffold; keep tokens in environment or an external adapter.",
        "Model task compatibility, quotas, response shape, and generated media import are not validated offline.",
      ],
      nodes: [
        {
          name: "hf_client",
          optype: "webclientDAT",
          x: 0,
          y: 120,
          params: { url: args.endpoint_url, reqmethod: "POST", active: args.active ? 1 : 0 },
        },
        { name: "input_map", optype: "tableDAT", x: 300, y: 120, table: inputRows(args) },
        { name: "output_map", optype: "tableDAT", x: 600, y: 120, table: outputRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["endpoint_url", args.endpoint_url],
            ["task", args.task],
            ["token_env_name", args.token_env_name],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use input_map/output_map as the TD-side task contract. A separate adapter should add auth headers, retry policy, and response decoding.",
        },
      ],
    },
    "connect_huggingface_inference_bridge failed",
    (report) =>
      `Created Hugging Face inference bridge ${report.container_path}; task ${args.task}; output ${args.output_mode}.`,
  );
}

export const registerConnectHuggingfaceInferenceBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_huggingface_inference_bridge",
    {
      title: "Connect Hugging Face inference bridge",
      description:
        "Create a Hugging Face Inference Endpoint scaffold with task input maps, output contracts, token-env hints, and adapter notes.",
      inputSchema: connectHuggingfaceInferenceBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectHuggingfaceInferenceBridgeImpl(ctx, args),
  );
};
