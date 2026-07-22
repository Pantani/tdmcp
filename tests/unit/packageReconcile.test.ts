import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PackageNamespaceApplyResult,
  type PackageNamespacePlan,
  type PackageQuarantineHandle,
  type PackageReconcileRecord,
  type ReconcilePackageNamespaceDependencies,
  ReconcilePackageNamespaceInputSchema,
  reconcilePackageNamespace,
} from "../../src/packages/reconcile.js";

const PLAN_ID = "plan_000000000000000000000001";
const INTERACTION_ID = "interaction_000000000000000001";

function record(overrides: Partial<PackageReconcileRecord> = {}): PackageReconcileRecord {
  return {
    id: "package-a",
    sourceUrl: "https://github.com/example/package-a",
    ref: "v1.0.0",
    scope: "project",
    bridgeTargetPath: "/project1/tdmcp_packages/package_a",
    stagedPath: "/private/staging/package-a",
    ...overrides,
  };
}

function plan(overrides: Partial<PackageNamespacePlan> = {}): PackageNamespacePlan {
  return {
    status: "planned",
    plan_id: PLAN_ID,
    expires_at: 1_000,
    package_id: "package-a",
    scope: "project",
    intent: "prune",
    classification: "aligned_owned",
    actionable: true,
    resolved_target_path: "/project1/tdmcp_packages/package_a",
    marker: { matched: true, schema_version: 1 },
    candidates: [
      {
        path: "/project1/tdmcp_packages/package_a",
        marker_status: "match",
        marker_schema_version: 1,
      },
    ],
    warnings: [],
    deduplicated: false,
    ...overrides,
  };
}

function live(
  action: "keep" | "bypass" | "delete" = "delete",
  overrides: Partial<PackageNamespaceApplyResult> = {},
): PackageNamespaceApplyResult {
  const decision = action === "delete" ? "Delete" : action === "bypass" ? "Bypass" : "Keep";
  return {
    status: action === "keep" ? "kept" : "applied",
    plan_id: PLAN_ID,
    package_id: "package-a",
    classification: "aligned_owned",
    resolved_target_path: "/project1/tdmcp_packages/package_a",
    decision,
    action_applied: action,
    final_path: action === "delete" ? null : "/project1/tdmcp_packages/package_a",
    confirmation_policy: "native",
    request_id: action === "bypass" ? null : INTERACTION_ID,
    marker: { matched: true, schema_version: 1 },
    warnings: [],
    ...overrides,
  };
}

function input(
  overrides: Partial<Parameters<typeof reconcilePackageNamespace>[0]> = {},
): Parameters<typeof reconcilePackageNamespace>[0] {
  return {
    packageId: "package-a",
    projectPath: "/project1",
    scope: "project",
    intent: "prune",
    dryRun: true,
    choice: "Keep",
    confirmationPolicy: "native",
    ...overrides,
  };
}

interface Harness {
  deps: ReconcilePackageNamespaceDependencies;
  events: string[];
  state: { record?: PackageReconcileRecord };
  bridgeCheck: ReturnType<typeof vi.fn>;
  bridgeApply: ReturnType<typeof vi.fn>;
  quarantine: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  journal: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const events: string[] = [];
  const state: { record?: PackageReconcileRecord } = { record: record() };
  const handle: PackageQuarantineHandle = { token: "opaque_quarantine_0001", prepared: true };
  const bridgeCheck = vi.fn(async () => {
    events.push("bridge.check");
    return plan();
  });
  const bridgeApply = vi.fn(async () => {
    events.push("bridge.apply");
    return live();
  });
  const quarantine = vi.fn(async () => {
    events.push("staging.quarantine");
    return handle;
  });
  const restore = vi.fn(async () => {
    events.push("staging.restore");
  });
  const discard = vi.fn(async () => {
    events.push("staging.discard");
  });
  const remove = vi.fn(async () => {
    events.push("records.remove");
    delete state.record;
  });
  const journal = vi.fn(async () => {
    events.push("journal.write");
  });
  const deps: ReconcilePackageNamespaceDependencies = {
    bridge: { check: bridgeCheck, apply: bridgeApply },
    records: {
      read: async () => {
        events.push("records.read");
        return state.record;
      },
      remove,
      exists: async () => {
        events.push("records.exists");
        return state.record !== undefined;
      },
    },
    staging: { quarantine, restore, discard },
    journal: { write: journal },
  };
  return {
    deps,
    events,
    state,
    bridgeCheck,
    bridgeApply,
    quarantine,
    restore,
    discard,
    remove,
    journal,
  };
}

describe("ReconcilePackageNamespaceInputSchema", () => {
  it("enforces dry-run first and exact native/YOLO interaction rules", () => {
    expect(ReconcilePackageNamespaceInputSchema.safeParse(input()).success).toBe(true);
    expect(
      ReconcilePackageNamespaceInputSchema.safeParse(input({ dryRun: true, planId: PLAN_ID }))
        .success,
    ).toBe(false);
    expect(
      ReconcilePackageNamespaceInputSchema.safeParse(
        input({ dryRun: false, choice: "Delete", planId: PLAN_ID }),
      ).success,
    ).toBe(false);
    expect(
      ReconcilePackageNamespaceInputSchema.safeParse(
        input({
          dryRun: false,
          choice: "Delete",
          planId: PLAN_ID,
          confirmationPolicy: "native",
          interactionId: INTERACTION_ID,
        }),
      ).success,
    ).toBe(true);
    expect(
      ReconcilePackageNamespaceInputSchema.safeParse(
        input({
          dryRun: false,
          choice: "Delete",
          planId: PLAN_ID,
          confirmationPolicy: "yolo",
          interactionId: INTERACTION_ID,
        }),
      ).success,
    ).toBe(false);
  });
});

describe("reconcilePackageNamespace", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("returns a bounded dry-run plan without local mutation", async () => {
    const result = await reconcilePackageNamespace(input(), h.deps);
    expect(result.status).toBe("planned");
    expect(h.bridgeCheck).toHaveBeenCalledWith({
      project_path: "/project1",
      package_id: "package-a",
      source_url: "https://github.com/example/package-a",
      recorded_ref: "v1.0.0",
      recorded_target_path: "/project1/tdmcp_packages/package_a",
      scope: "project",
      intent: "prune",
    });
    expect(h.events).toEqual(["records.read", "bridge.check"]);
    expect(JSON.stringify(result)).not.toContain("/private/staging");
  });

  it("fails closed when no matching installed record exists", async () => {
    delete h.state.record;
    const result = await reconcilePackageNamespace(input(), h.deps);
    expect(result).toMatchObject({ status: "failed", code: "package_not_recorded" });
    expect(h.bridgeCheck).not.toHaveBeenCalled();
  });

  it("Keep never calls the live mutation or touches disk/state", async () => {
    const result = await reconcilePackageNamespace(
      input({ dryRun: false, planId: PLAN_ID, choice: "Keep" }),
      h.deps,
    );
    expect(result).toMatchObject({ status: "kept", planId: PLAN_ID });
    expect(h.bridgeApply).not.toHaveBeenCalled();
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("Bypass is one explicit live apply and preserves local state", async () => {
    h.bridgeApply.mockImplementationOnce(async () => live("bypass", { request_id: null }));
    const result = await reconcilePackageNamespace(
      input({ dryRun: false, planId: PLAN_ID, choice: "Bypass" }),
      h.deps,
    );
    expect(result.status).toBe("applied");
    expect(h.bridgeApply).toHaveBeenCalledWith({
      plan_id: PLAN_ID,
      choice: "Bypass",
      confirmation_policy: "explicit_mode",
    });
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.state.record).toBeDefined();
  });

  it("Delete quarantines first, applies once, commits registry, then discards", async () => {
    const result = await reconcilePackageNamespace(
      input({
        dryRun: false,
        planId: PLAN_ID,
        choice: "Delete",
        interactionId: INTERACTION_ID,
      }),
      h.deps,
    );
    expect(result).toMatchObject({
      status: "applied",
      storage: {
        quarantined: true,
        recordRemoved: true,
        quarantineDiscarded: true,
      },
    });
    expect(h.events).toEqual([
      "records.read",
      "records.read",
      "staging.quarantine",
      "bridge.apply",
      "records.remove",
      "records.exists",
      "staging.discard",
    ]);
  });

  it("native Keep/Bypass restores quarantine and never removes the record", async () => {
    for (const action of ["keep", "bypass"] as const) {
      h = harness();
      h.bridgeApply.mockImplementationOnce(async () => live(action));
      const result = await reconcilePackageNamespace(
        input({
          dryRun: false,
          planId: PLAN_ID,
          choice: "Delete",
          interactionId: INTERACTION_ID,
        }),
        h.deps,
      );
      expect(result.status).toBe(action === "keep" ? "kept" : "applied");
      expect(h.restore).toHaveBeenCalledOnce();
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.state.record).toBeDefined();
    }
  });

  it("restores quarantine and retains state when the live call fails", async () => {
    h.bridgeApply.mockRejectedValueOnce(new Error("secret bridge detail"));
    const result = await reconcilePackageNamespace(
      input({
        dryRun: false,
        planId: PLAN_ID,
        choice: "Delete",
        interactionId: INTERACTION_ID,
      }),
      h.deps,
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "live_apply_failed",
      storage: { restored: true, recordRemoved: false },
    });
    expect(h.remove).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret bridge detail");
  });

  it("reports and journals partial failure when registry commit fails after TD delete", async () => {
    h.remove.mockRejectedValueOnce(new Error("registry unavailable"));
    const result = await reconcilePackageNamespace(
      input({
        dryRun: false,
        planId: PLAN_ID,
        choice: "Delete",
        interactionId: INTERACTION_ID,
      }),
      h.deps,
    );
    expect(result).toMatchObject({
      status: "partial_failure",
      code: "registry_commit_failed",
      storage: { restored: true, recordRemoved: false },
    });
    expect(h.restore).toHaveBeenCalledOnce();
    expect(h.journal).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "registry_commit", planId: PLAN_ID }),
    );
  });

  it("journals bounded remediation when only quarantine cleanup fails", async () => {
    h.discard.mockRejectedValueOnce(new Error("private quarantine path"));
    const result = await reconcilePackageNamespace(
      input({
        dryRun: false,
        planId: PLAN_ID,
        choice: "Delete",
        interactionId: INTERACTION_ID,
      }),
      h.deps,
    );
    expect(result).toMatchObject({
      status: "partial_failure",
      code: "quarantine_cleanup_failed",
      storage: { recordRemoved: true, quarantineDiscarded: false },
    });
    expect(h.journal).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "quarantine_cleanup", planId: PLAN_ID }),
    );
    expect(JSON.stringify(result)).not.toContain("private quarantine path");
  });

  it("detects a local record change before quarantine", async () => {
    let reads = 0;
    h.deps.records.read = async () => {
      reads += 1;
      return reads === 1 ? record() : record({ ref: "v2.0.0" });
    };
    const result = await reconcilePackageNamespace(
      input({
        dryRun: false,
        planId: PLAN_ID,
        choice: "Delete",
        interactionId: INTERACTION_ID,
      }),
      h.deps,
    );
    expect(result).toMatchObject({ status: "failed", code: "package_state_changed" });
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(h.bridgeApply).not.toHaveBeenCalled();
  });
});
