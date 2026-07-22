import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  operationCommitReceiptSchema,
  operationPlanErrorSchema,
  operationPlanSchema,
} from "../../src/td-client/operationPlanValidators.js";

type JsonObject = Record<string, unknown>;
type GoldenTarget = { path?: string; ref?: string };
type GoldenIntent = JsonObject & {
  kind: string;
  ref?: string;
  name?: string;
  source?: GoldenTarget;
  target?: GoldenTarget;
  values?: JsonObject;
};
type GoldenPlan = JsonObject & {
  owner_path: string;
  intents: GoldenIntent[];
};
type PlanCase = {
  id: string;
  accept: boolean;
  plan: unknown;
  canonical_utf8_hex?: string;
  plan_digest?: string;
  affected_paths?: string[];
  counts?: Record<string, number>;
  error?: { class: string; code: string };
};
type ReceiptCase = {
  id: string;
  accept: boolean;
  fragment: JsonObject;
};
type GoldenCorpus = {
  schema_version: number;
  plan_cases: PlanCase[];
  public_error_cases: Array<{ code: string; accept: boolean }>;
  receipt_plan_case_id: string;
  receipt_context: { operation_id: string; journal_label: string };
  terminal_receipt_cases: ReceiptCase[];
};

const corpusPath = resolve(process.cwd(), "tests/fixtures/operation-plan-golden.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as GoldenCorpus;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${entries.join(",")}}`;
}

function pythonJsonType(value: unknown): string {
  if (value === null) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}

function publicPlanShape(plan: GoldenPlan): GoldenPlan {
  const shaped = JSON.parse(JSON.stringify(plan)) as GoldenPlan;
  for (const intent of shaped.intents) {
    if (intent.kind === "set_constant_parameters" && intent.values !== undefined) {
      intent.values = Object.fromEntries(
        Object.entries(intent.values).map(([name, value]) => [name, pythonJsonType(value)]),
      );
    }
    for (const field of ["comment", "title", "body"] as const) {
      if (field in intent) intent[field] = "<redacted>";
    }
  }
  return shaped;
}

function resolveTarget(target: GoldenTarget, aliases: Map<string, string>): string {
  if (target.path !== undefined) return target.path;
  const path = target.ref === undefined ? undefined : aliases.get(target.ref);
  if (path === undefined) throw new Error("golden target was not canonicalized");
  return path;
}

function operationSummary(plan: GoldenPlan): {
  affectedPaths: string[];
  counts: Record<string, number>;
} {
  const aliases = new Map<string, string>();
  const affected = new Set<string>();
  const counts = {
    intents: plan.intents.length,
    creates: 0,
    parameter_writes: 0,
    metadata_writes: 0,
    connects: 0,
    disconnects: 0,
  };
  for (const intent of plan.intents) {
    if (intent.kind === "create_operator" || intent.kind === "create_annotation") {
      const parent = resolveTarget(intent.parent as GoldenTarget, aliases);
      const path = `${parent}/${intent.name}`.replace("//", "/");
      aliases.set(intent.ref as string, path);
      affected.add(path);
      counts.creates += 1;
    } else if (intent.kind === "set_constant_parameters") {
      affected.add(resolveTarget(intent.target as GoldenTarget, aliases));
      counts.parameter_writes += Object.keys(intent.values ?? {}).length;
    } else if (intent.kind === "edit_metadata") {
      affected.add(resolveTarget(intent.target as GoldenTarget, aliases));
      counts.metadata_writes += Object.keys(intent).filter(
        (field) => field !== "kind" && field !== "target",
      ).length;
    } else {
      affected.add(resolveTarget(intent.source as GoldenTarget, aliases));
      affected.add(resolveTarget(intent.target as GoldenTarget, aliases));
      counts[intent.kind === "connect" ? "connects" : "disconnects"] += 1;
    }
  }
  return { affectedPaths: [...affected].sort(), counts };
}

function receiptEnvelope(fragment: JsonObject, planCase: PlanCase): JsonObject {
  return {
    operation_id: corpus.receipt_context.operation_id,
    receipt_capability: "c".repeat(43),
    bridge_instance_id: "bridge-instance-golden",
    plan_digest: planCase.plan_digest,
    owner_path: (planCase.plan as GoldenPlan).owner_path,
    affected_paths: planCase.affected_paths,
    ...fragment,
  };
}

describe("shared operation-plan golden corpus", () => {
  it("locks accept/reject, public error class, canonical bytes, digest, and paths", () => {
    expect(corpus.schema_version).toBe(1);
    for (const testCase of corpus.plan_cases) {
      const parsed = operationPlanSchema.safeParse(testCase.plan);
      expect(parsed.success, testCase.id).toBe(testCase.accept);
      if (!testCase.accept) {
        expect(testCase.error?.class, testCase.id).toBe("OperationPlanError");
        expect(
          operationPlanErrorSchema.safeParse({
            code: testCase.error?.code,
            message: "Golden operation-plan rejection.",
          }).success,
          testCase.id,
        ).toBe(true);
        continue;
      }
      if (!parsed.success) throw new Error(`accepted golden plan failed: ${testCase.id}`);
      const plan = parsed.data as GoldenPlan;
      const canonical = canonicalJson(plan);
      expect(Buffer.from(canonical, "utf8").toString("hex"), testCase.id).toBe(
        testCase.canonical_utf8_hex,
      );
      expect(
        createHash("sha256")
          .update(canonicalJson(publicPlanShape(plan)))
          .digest("hex"),
        testCase.id,
      ).toBe(testCase.plan_digest);
      const summary = operationSummary(plan);
      expect(summary.affectedPaths, testCase.id).toEqual(testCase.affected_paths);
      expect(summary.counts, testCase.id).toEqual(testCase.counts);
    }
  });

  it("locks the shared public error-code intersection", () => {
    for (const testCase of corpus.public_error_cases) {
      const parsed = operationPlanErrorSchema.safeParse({
        code: testCase.code,
        message: "Bounded public error.",
      });
      expect(parsed.success, testCase.code).toBe(testCase.accept);
    }
  });

  it("locks all common terminal receipt safety states", () => {
    const planCase = corpus.plan_cases.find(
      (candidate) => candidate.id === corpus.receipt_plan_case_id,
    );
    if (planCase === undefined) throw new Error("receipt plan case is missing");
    for (const testCase of corpus.terminal_receipt_cases) {
      const parsed = operationCommitReceiptSchema.safeParse(
        receiptEnvelope(testCase.fragment, planCase),
      );
      expect(parsed.success, testCase.id).toBe(testCase.accept);
    }
  });
});
