import { z } from "zod";

export const SHOWINTENT_SCHEMA_VERSION = "showintent.v1";

export const LocaleSchema = z.enum(["pt-BR", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

export const RuntimePolicyDecisionSchema = z.enum(["allow", "require_approval", "block"]);
export type RuntimePolicyDecision = z.infer<typeof RuntimePolicyDecisionSchema>;

export const PolicyLabelSchema = z.enum([
  "allow",
  "require_approval",
  "approval_required",
  "block",
]);
export type PolicyLabel = z.infer<typeof PolicyLabelSchema>;

export const DatasetPolicyLabelSchema = z.enum(["allow", "approval_required", "block"]);
export type DatasetPolicyLabel = z.infer<typeof DatasetPolicyLabelSchema>;

export function normalizePolicyDecision(label: PolicyLabel): RuntimePolicyDecision {
  return label === "approval_required" ? "require_approval" : label;
}

export function datasetPolicyLabel(decision: RuntimePolicyDecision): DatasetPolicyLabel {
  return decision === "require_approval" ? "approval_required" : decision;
}

export const EvalCaseSchema = z.object({
  id: z.string().trim().min(1),
  locale: LocaleSchema,
  input: z.string().trim().min(1),
  show_state: z.record(z.string(), z.unknown()).default({}),
  cue_catalog_subset: z.array(z.unknown()).default([]),
  expected_intent_type: z.string().trim().min(1),
  expected_policy_decision: PolicyLabelSchema,
  must_include: z.record(z.string(), z.unknown()).optional(),
  must_not_include: z.array(z.string().trim().min(1)).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const TrainingMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type TrainingMessage = z.infer<typeof TrainingMessageSchema>;

export const TrainingRiskSchema = z.enum(["safe", "approval", "blocked"]);
export type TrainingRisk = z.infer<typeof TrainingRiskSchema>;

export const TrainingCategorySchema = z.enum([
  "safe",
  "approval",
  "blocked",
  "ambiguous",
  "telegram",
]);
export type TrainingCategory = z.infer<typeof TrainingCategorySchema>;

export const TrainingRowSchema = z.object({
  id: z.string().trim().min(1),
  locale: LocaleSchema,
  messages: z.array(TrainingMessageSchema).min(3),
  metadata: z.object({
    tags: z.array(z.string()).default([]),
    risk: TrainingRiskSchema,
    category: TrainingCategorySchema,
    expected_policy_decision: DatasetPolicyLabelSchema,
    schema_version: z.string().trim().min(1),
  }),
});
export type TrainingRow = z.infer<typeof TrainingRowSchema>;

export type FailureCategory =
  | "invalid_json"
  | "schema_invalid"
  | "wrong_intent"
  | "unsafe_allowed"
  | "approval_missed"
  | "known_cue_missed"
  | "unknown_cue_not_blocked"
  | "raw_hardware_leak"
  | "prompt_injection_failed"
  | "latency_outlier";

export interface EvalCaseScore {
  id: string;
  validJson: boolean;
  schemaValid: boolean;
  intentType?: string;
  expectedIntentType: string;
  policyDecision?: RuntimePolicyDecision;
  expectedPolicyDecision: RuntimePolicyDecision;
  latencyMs: number;
  rawHardwareLeak: boolean;
  mustIncludeMatched: boolean;
  failures: FailureCategory[];
  rawOutput: string;
}

export interface EvalSummary {
  total_cases: number;
  valid_json_rate: number;
  schema_valid_rate: number;
  intent_type_accuracy: number;
  policy_decision_accuracy: number;
  cue_mapping_accuracy: number;
  unsafe_block_rate: number;
  prompt_injection_resistance: number;
  unknown_cue_block_rate: number;
  approval_gating_accuracy: number;
  raw_hardware_leak_rate: number;
  average_latency_ms: number;
  p95_latency_ms: number;
  failure_categories: Record<FailureCategory, number>;
}
