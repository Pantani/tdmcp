import { z } from "zod";

/** Standard response envelope every bridge endpoint returns. */
export const ApiEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string() }).optional(),
});
export type ApiEnvelope = z.infer<typeof ApiEnvelopeSchema>;

export const NodeRefSchema = z.object({
  path: z.string(),
  type: z.string().default(""),
  name: z.string().default(""),
  /** Parameters that could not be applied at create time (unknown name or bad value). */
  parameter_warnings: z.array(z.string()).optional(),
});
export type TdNodeRef = z.infer<typeof NodeRefSchema>;

export const NodeDetailSchema = NodeRefSchema.extend({
  parameters: z.record(z.string(), z.unknown()).default({}),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  family: z.string().optional(),
  errors: z.array(z.string()).optional(),
});
export type TdNodeDetail = z.infer<typeof NodeDetailSchema>;

export const NodeListSchema = z.object({ nodes: z.array(NodeRefSchema).default([]) });
export type TdNodeList = z.infer<typeof NodeListSchema>;

export const InfoSchema = z.object({
  td_version: z.string().optional(),
  python_version: z.string().optional(),
  build: z.string().optional(),
  bridge_version: z.string().optional(),
  project: z.string().optional(),
});
export type TdInfo = z.infer<typeof InfoSchema>;

export const NodeErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
  type: z.string().optional(),
});
export type TdNodeError = z.infer<typeof NodeErrorSchema>;

export const NodeErrorsSchema = z.object({ errors: z.array(NodeErrorSchema).default([]) });
export type TdNodeErrors = z.infer<typeof NodeErrorsSchema>;

export const PreviewSchema = z.object({
  path: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.string().default("png"),
  base64: z.string(),
});
export type TdPreview = z.infer<typeof PreviewSchema>;

export const ExecResultSchema = z.object({
  result: z.unknown().optional(),
  stdout: z.string().optional(),
  printed: z.array(z.string()).optional(),
});
export type TdExecResult = z.infer<typeof ExecResultSchema>;

export const MethodResultSchema = z.object({ result: z.unknown() });
export type TdMethodResult = z.infer<typeof MethodResultSchema>;

export const DeleteResultSchema = z.object({ deleted: z.string() });
export type TdDeleteResult = z.infer<typeof DeleteResultSchema>;

export const ConnectionSchema = z.object({
  source_path: z.string(),
  source_output: z.number().int().default(0),
  target_path: z.string(),
  target_input: z.number().int().default(0),
});
export type TdConnection = z.infer<typeof ConnectionSchema>;

export const TopologySchema = z.object({
  nodes: z.array(NodeRefSchema).default([]),
  connections: z.array(ConnectionSchema).default([]),
});
export type TdTopology = z.infer<typeof TopologySchema>;

export const PerformanceSchema = z.object({
  nodes: z
    .array(
      z.object({
        path: z.string(),
        cook_time_ms: z.number().default(0),
        cook_count: z.number().optional(),
      }),
    )
    .default([]),
  total_cook_time_ms: z.number().optional(),
  gpu_memory_mb: z.number().optional(),
});
export type TdPerformance = z.infer<typeof PerformanceSchema>;

export const BatchOpResultSchema = z.object({
  action: z.string(),
  ok: z.boolean(),
  path: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export const BatchResultSchema = z.object({ results: z.array(BatchOpResultSchema).default([]) });
export type TdBatchResult = z.infer<typeof BatchResultSchema>;

/** Input shape for creating a node (used by the client and Layer 3 tool). */
export const CreateNodeInputSchema = z.object({
  parent_path: z.string(),
  type: z.string(),
  name: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type CreateNodeInput = z.infer<typeof CreateNodeInputSchema>;

/** A single atomic operation accepted by `POST /api/batch`. */
export const BatchOperationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    parent_path: z.string(),
    type: z.string(),
    name: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    action: z.literal("update"),
    path: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
  z.object({ action: z.literal("delete"), path: z.string() }),
  z.object({
    action: z.literal("connect"),
    source_path: z.string(),
    target_path: z.string(),
    source_output: z.number().int().default(0),
    target_input: z.number().int().default(0),
  }),
]);
export type TdBatchOperation = z.infer<typeof BatchOperationSchema>;
