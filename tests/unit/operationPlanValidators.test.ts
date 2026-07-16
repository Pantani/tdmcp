import { describe, expect, it } from "vitest";
import {
  operationCommitReceiptSchema,
  operationCommitSchema,
  operationPlanErrorSchema,
  operationPlanSchema,
  operationPreviewSchema,
} from "../../src/td-client/operationPlanValidators.js";

function plan(value: unknown = 0.5) {
  return {
    schema_version: 1 as const,
    label: "Build insert",
    owner_path: "/project1/show",
    intents: [
      {
        kind: "create_operator" as const,
        ref: "insert",
        type: "nullTOP" as const,
        name: "insert1",
        parent: { path: "/project1/show" },
        position: { x: 200, y: 100 },
        viewer: false,
      },
      {
        kind: "set_constant_parameters" as const,
        target: { ref: "insert" },
        values: { opacity: value },
      },
    ],
  };
}

function preview() {
  return {
    status: "preview" as const,
    schema_version: 1 as const,
    bridge_instance_id: "bridge-instance-wave12",
    preview_token: "opaque.payload",
    expires_at: "2026-07-15T18:00:00Z",
    plan_digest: "a".repeat(64),
    owner_path: "/project1/show",
    label: "Build insert",
    effects: [
      {
        index: 0,
        kind: "create_operator" as const,
        target_paths: ["/project1/show/insert1"],
        field_names: ["type", "position"],
        summary: "create_operator affects one bounded path",
      },
    ],
    affected_paths: ["/project1/show/insert1"],
    counts: {
      intents: 2,
      creates: 1,
      parameter_writes: 1,
      metadata_writes: 0,
      connects: 0,
      disconnects: 0,
    },
    risk: "bounded_graph_mutation" as const,
    rollback_coverage: "unverified_for_allowlist" as const,
    journal_eligible: false as const,
    warnings: [],
  };
}

function receipt(status: "applied" | "failed_rollback" | "outcome_unknown" = "applied") {
  return {
    status,
    operation_id: "operation-wave12-0001",
    receipt_capability: "a".repeat(43),
    bridge_instance_id: "bridge-instance-wave12",
    plan_digest: "a".repeat(64),
    owner_path: "/project1/show",
    affected_paths: ["/project1/show/insert1"],
    results:
      status === "outcome_unknown"
        ? []
        : [
            {
              index: 0,
              kind: "create_operator" as const,
              status: status === "applied" ? ("applied" as const) : ("rollback_failed" as const),
              final_paths: ["/project1/show/insert1"],
            },
          ],
    verification: {
      status: status === "applied" ? ("PASS" as const) : ("FAIL" as const),
      snapshot: status === "applied" ? ("after" as const) : ("unknown" as const),
    },
    rollback: {
      attempted: status === "failed_rollback",
      succeeded: status === "applied",
      errors:
        status === "failed_rollback"
          ? [{ index: 0, code: "rollback_failed", message: "Restore failed." }]
          : [],
    },
    journal: {
      registered: status === "applied",
      operation_id: status === "applied" ? "operation-wave12-0001" : null,
      label: status === "applied" ? "MCP operation Build insert" : null,
      native_stack_delta: status === "applied" ? (1 as const) : (0 as const),
      observed_state: status === "applied" ? ("applied" as const) : ("unknown" as const),
    },
    warnings: [],
    ...(status === "applied"
      ? {}
      : {
          error: {
            code: status === "failed_rollback" ? "rollback_failed" : status,
            message: "Structured operation did not establish a safe final state.",
          },
        }),
  };
}

describe("operation plan validators", () => {
  it("accepts the bounded allowlisted plan and rejects unknown fields", () => {
    expect(operationPlanSchema.safeParse(plan()).success).toBe(true);
    expect(operationPlanSchema.safeParse({ ...plan(), python: "op('/').destroy()" }).success).toBe(
      false,
    );
  });

  it("rejects unsafe operator types, forward aliases and cross-owner paths", () => {
    expect(
      operationPlanSchema.safeParse({
        ...plan(),
        intents: [{ ...plan().intents[0], type: "moviefileinTOP" }, plan().intents[1]],
      }).success,
    ).toBe(false);
    expect(operationPlanSchema.safeParse({ ...plan(), owner_path: "/project1/*" }).success).toBe(
      false,
    );
    expect(
      operationPlanSchema.safeParse({
        ...plan(),
        intents: [
          plan().intents[0],
          { ...plan().intents[1], target: { path: "/project1/show/insert1" } },
        ],
      }).success,
    ).toBe(false);

    const forward = plan();
    forward.intents.reverse();
    expect(operationPlanSchema.safeParse(forward).success).toBe(false);

    expect(
      operationPlanSchema.safeParse({
        ...plan(),
        intents: [
          plan().intents[0],
          { ...plan().intents[1], target: { path: "/project1/other/node1" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects bounded-JSON violations and aggregate capacities", () => {
    expect(operationPlanSchema.safeParse(plan(Number.NaN)).success).toBe(false);
    expect(operationPlanSchema.safeParse(plan("x".repeat(4_097))).success).toBe(false);
    const many = plan();
    many.intents = Array.from({ length: 17 }, (_, index) => ({
      ...many.intents[0],
      ref: `node${index}`,
      name: `node${index}`,
    })) as typeof many.intents;
    expect(operationPlanSchema.safeParse(many).success).toBe(false);

    const metadata = {
      kind: "edit_metadata" as const,
      target: { ref: "insert" },
      position: { x: 1, y: 2 },
      color: [0.1, 0.2, 0.3] as [number, number, number],
      comment: "safe",
      viewer: false,
      bypass: false,
      display: false,
      render: false,
    };
    expect(
      operationPlanSchema.safeParse({
        ...plan(),
        intents: [plan().intents[0], ...Array.from({ length: 19 }, () => ({ ...metadata }))],
      }).success,
    ).toBe(false);
  });

  it("uses UTF-8 byte caps consistently for public Unicode inputs", () => {
    expect(operationPlanSchema.safeParse({ ...plan(), label: "é".repeat(48) }).success).toBe(true);
    expect(operationPlanSchema.safeParse({ ...plan(), label: "é".repeat(49) }).success).toBe(false);

    expect(operationPlanSchema.safeParse(plan("🙂".repeat(512))).success).toBe(true);
    expect(operationPlanSchema.safeParse(plan("🙂".repeat(513))).success).toBe(false);

    expect(operationPlanSchema.safeParse(plan({ ["é".repeat(64)]: true })).success).toBe(true);
    expect(operationPlanSchema.safeParse(plan({ ["é".repeat(65)]: true })).success).toBe(false);
    expect(operationPlanSchema.safeParse(plan("\ud800")).success).toBe(false);
    expect(operationPlanSchema.safeParse({ ...plan(), label: "bad\udfff" }).success).toBe(false);
    expect(operationPlanSchema.safeParse(plan({ "bad\ud800": true })).success).toBe(false);

    const maxBody = "🙂".repeat(2_048);
    const annotation = {
      ...plan(),
      intents: [
        {
          kind: "create_annotation" as const,
          ref: "note",
          name: "note1",
          parent: { path: "/project1/show" },
          bounds: { x: 0, y: 0, w: 100, h: 100 },
          body: maxBody,
        },
      ],
    };
    expect(operationPlanSchema.safeParse(annotation).success).toBe(true);
    expect(
      operationPlanSchema.safeParse({
        ...annotation,
        intents: [{ ...annotation.intents[0], body: `${maxBody}🙂` }],
      }).success,
    ).toBe(false);
  });

  it("requires exact context ownership and a unique bounded selection", () => {
    const valid = {
      ...plan(),
      expected_context: {
        owner_path: "/project1/show",
        current_path: "/project1/show/source",
        selected_paths: ["/project1/show/source"],
      },
    };
    expect(operationPlanSchema.safeParse(valid).success).toBe(true);
    expect(
      operationPlanSchema.safeParse({
        ...valid,
        expected_context: {
          ...valid.expected_context,
          selected_paths: ["/project1/show/source", "/project1/show/source"],
        },
      }).success,
    ).toBe(false);
  });

  it("validates commit credentials strictly and enforces its body cap", () => {
    const commit = {
      ...plan(),
      preview_token: "opaque.payload",
      idempotency_key: "wave12-safe-key-0001",
    };
    expect(operationCommitSchema.safeParse(commit).success).toBe(true);
    expect(operationCommitSchema.safeParse({ ...commit, idempotency_key: "short" }).success).toBe(
      false,
    );
  });

  it("accepts only complete strict redacted preview envelopes", () => {
    expect(operationPreviewSchema.safeParse(preview()).success).toBe(true);
    expect(
      operationPreviewSchema.safeParse({ ...preview(), secret_parameter_value: "do-not-return" })
        .success,
    ).toBe(false);
    expect(
      operationPreviewSchema.safeParse({ ...preview(), affected_paths: Array(65).fill("/a/b") })
        .success,
    ).toBe(false);
    expect(operationPreviewSchema.safeParse({ ...preview(), journal_eligible: true }).success).toBe(
      false,
    );
  });

  it("prevents failure receipts from rendering as safe restoration or success", () => {
    expect(operationCommitReceiptSchema.safeParse(receipt()).success).toBe(true);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...receipt(),
        idempotency_key: "must-never-be-recovery-authority",
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...receipt(),
        receipt_capability: "too-short",
      }).success,
    ).toBe(false);
    expect(operationCommitReceiptSchema.safeParse(receipt("failed_rollback")).success).toBe(true);
    expect(operationCommitReceiptSchema.safeParse(receipt("outcome_unknown")).success).toBe(true);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...receipt("failed_rollback"),
        rollback: { attempted: true, succeeded: true, errors: [] },
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...receipt(),
        verification: { status: "FAIL", snapshot: "unknown" },
        journal: {
          registered: false,
          operation_id: null,
          label: null,
          native_stack_delta: 0,
          observed_state: "unknown",
        },
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...receipt("failed_rollback"),
        status: "replayed",
      }).success,
    ).toBe(false);
    const missingError = receipt("outcome_unknown");
    delete (missingError as { error?: unknown }).error;
    expect(operationCommitReceiptSchema.safeParse(missingError).success).toBe(false);
  });

  it("rejects structurally incoherent results, rollback errors, journals, and replay snapshots", () => {
    const applied = receipt();
    expect(operationCommitReceiptSchema.safeParse({ ...applied, results: [] }).success).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...applied,
        results: [applied.results[0], applied.results[0]],
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...applied,
        results: [{ ...applied.results[0], final_paths: ["/project1/show/not-affected"] }],
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...applied,
        results: [{ ...applied.results[0], final_paths: [] }],
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...applied,
        results: [
          {
            ...applied.results[0],
            final_paths: ["/project1/show/insert1", "/project1/show/insert1"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...applied,
        affected_paths: ["/project1/show/insert1", "/project1/show/insert1"],
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...applied,
        results: [{ ...applied.results[0], index: 31 }],
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...applied,
        rollback: {
          attempted: false,
          succeeded: true,
          errors: [{ index: 0, code: "unexpected", message: "Must be empty." }],
        },
      }).success,
    ).toBe(false);

    const rollbackFailure = receipt("failed_rollback");
    expect(
      operationCommitReceiptSchema.safeParse({
        ...rollbackFailure,
        results: [],
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...rollbackFailure,
        rollback: {
          ...rollbackFailure.rollback,
          errors: [rollbackFailure.rollback.errors[0], rollbackFailure.rollback.errors[0]],
        },
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...rollbackFailure,
        results: [{ ...rollbackFailure.results[0], status: "rolled_back" }],
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...rollbackFailure,
        rollback: {
          ...rollbackFailure.rollback,
          errors: [{ index: 31, code: "rollback_failed", message: "Unknown result." }],
        },
      }).success,
    ).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...rollbackFailure,
        journal: { ...rollbackFailure.journal, observed_state: "drifted" },
      }).success,
    ).toBe(false);

    const replayed = { ...applied, status: "replayed" as const };
    expect(operationCommitReceiptSchema.safeParse(replayed).success).toBe(true);
    const undone = {
      ...replayed,
      journal: { ...replayed.journal, observed_state: "undone" as const },
    };
    expect(operationCommitReceiptSchema.safeParse(undone).success).toBe(false);
    expect(
      operationCommitReceiptSchema.safeParse({
        ...undone,
        verification: { status: "PASS", snapshot: "before" },
      }).success,
    ).toBe(true);

    const unknown = receipt("outcome_unknown");
    expect(
      operationCommitReceiptSchema.safeParse({
        ...unknown,
        rollback: { attempted: true, succeeded: false, errors: [] },
      }).success,
    ).toBe(false);
  });

  it("keeps the live-unverified boundary as an explicit typed error", () => {
    expect(
      operationPlanErrorSchema.parse({
        code: "unverified_live_boundary",
        message: "Native callback journal is pending live validation.",
      }),
    ).toEqual({
      code: "unverified_live_boundary",
      message: "Native callback journal is pending live validation.",
    });
    for (const code of ["operation_authority", "receipt_unavailable"] as const) {
      expect(
        operationPlanErrorSchema.safeParse({ code, message: "Safe bounded error." }).success,
      ).toBe(true);
    }
    expect(
      operationPlanErrorSchema.safeParse({ code: "python_exception", message: "raw repr" }).success,
    ).toBe(false);
  });
});
