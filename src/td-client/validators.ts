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

/** Operator flags reported in a node detail (all optional; family-dependent). */
export const NodeFlagsSchema = z.object({
  bypass: z.boolean().optional(),
  render: z.boolean().optional(),
  display: z.boolean().optional(),
  lock: z.boolean().optional(),
  allowCooking: z.boolean().optional(),
  cloneImmune: z.boolean().optional(),
  is_clone: z.boolean().optional(),
  clone: z.string().nullable().optional(),
});
export type TdNodeFlags = z.infer<typeof NodeFlagsSchema>;

/** One index-aware input wire on a node: which slot, from which op's output. */
export const NodeWireSchema = z.object({
  in_index: z.number().int().nullable(),
  from: z.string(),
  out_index: z.number().int(),
});
export type TdNodeWire = z.infer<typeof NodeWireSchema>;

export const NodeDetailSchema = NodeRefSchema.extend({
  parameters: z.record(z.string(), z.unknown()).default({}),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  family: z.string().optional(),
  errors: z.array(z.string()).optional(),
  // --- NEW (node_flags_in_detail): cosmetic + behavioral signals for a faithful round-trip ---
  flags: NodeFlagsSchema.optional(),
  wires_in: z.array(NodeWireSchema).optional(),
  nodeX: z.number().optional(),
  nodeY: z.number().optional(),
  comment: z.string().optional(),
  color: z.array(z.number()).optional(),
  tags: z.array(z.string()).optional(),
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

// --- First-class wiring endpoints (POST /api/connect, /api/disconnect) ---
export const ConnectResultSchema = z.object({
  source_path: z.string(),
  target_path: z.string(),
  requested_input: z.number().int().optional(),
  actual_input: z.number().int().optional(),
  source_output: z.number().int().default(0),
  connected: z.boolean().default(true),
});
export type TdConnectResult = z.infer<typeof ConnectResultSchema>;

export const DisconnectResultSchema = z.object({
  to_path: z.string(),
  from_path: z.string().nullable().optional(),
  to_input: z.number().int().nullable().optional(),
  removed: z.array(z.object({ input: z.number().int(), from: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});
export type TdDisconnectResult = z.infer<typeof DisconnectResultSchema>;

// --- Param-mode + DAT-text endpoints (survive ALLOW_EXEC=0) ---
export const ParamModeEntrySchema = z.object({
  name: z.string(),
  mode: z.string(),
  value: z.unknown().optional(),
  expr: z.string().optional(),
  bind_expr: z.string().optional(),
  export_op: z.string().optional(),
});
export const ParamModesSchema = z.object({
  path: z.string(),
  type: z.string().default(""),
  name: z.string().default(""),
  parameters: z.array(ParamModeEntrySchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type TdParamModes = z.infer<typeof ParamModesSchema>;

export const SetParamModeResultSchema = z.object({
  path: z.string(),
  param: z.string(),
  mode: z.string(),
  readback_mode: z.string().default(""),
  readback_expr: z.string().default(""),
});
export type TdSetParamModeResult = z.infer<typeof SetParamModeResultSchema>;

export const DatTextSchema = z.object({
  path: z.string(),
  text: z.string().default(""),
  is_table: z.boolean().default(false),
  num_rows: z.number().int().default(0),
  num_cols: z.number().int().default(0),
});
export type TdDatText = z.infer<typeof DatTextSchema>;

export const DatTextWriteSchema = z.object({
  path: z.string(),
  old_length: z.number().int().default(0),
  new_length: z.number().int().default(0),
});
export type TdDatTextWrite = z.infer<typeof DatTextWriteSchema>;

// --- Structured bridge logs (GET /api/logs) ---
export const BridgeLogLineSchema = z.object({
  source: z.string().default(""),
  message: z.string().default(""),
  absframe: z.number().int().optional(),
  frame: z.number().int().optional(),
  severity: z.string().default(""),
  type: z.string().default(""),
});
export const BridgeLogsSchema = z.object({
  lines: z.array(BridgeLogLineSchema).default([]),
  count: z.number().int().default(0),
  error_dat: z.string().optional(),
  available: z.boolean().default(true),
  warnings: z.array(z.string()).default([]),
});
export type TdBridgeLogs = z.infer<typeof BridgeLogsSchema>;

// --- Timeline transport (POST /api/transport) ---
// Matches transport_service.control()'s return shape: {action, play, frame, rate,
// startFrame, endFrame, fps}. Kept identical to the legacy exec-script stdout so
// the Node-side tool can collapse both branches into one result handler.
export const TransportStateSchema = z.object({
  action: z.string(),
  play: z.boolean(),
  frame: z.number().int(),
  rate: z.number(),
  startFrame: z.number().int(),
  endFrame: z.number().int(),
  fps: z.number(),
});
export type TdTransportState = z.infer<typeof TransportStateSchema>;
