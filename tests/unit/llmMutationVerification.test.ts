import { describe, expect, it, vi } from "vitest";
import {
  connectMutationDescriptor,
  createMutationDescriptor,
  deleteMutationDescriptor,
  generatorMutationDescriptor,
  updateParametersMutationDescriptor,
  verifyMutation,
} from "../../src/llm/mutationVerification.js";
import { TdApiError, TdTimeoutError } from "../../src/td-client/types.js";

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getNode: vi.fn().mockResolvedValue({
      path: "/project1/noise1",
      type: "noiseTOP",
      family: "TOP",
      parameters: { period: 2 },
      flags: { bypass: false },
      nodeX: 100,
      nodeY: -50,
      viewer: true,
    }),
    getNetworkTopology: vi.fn().mockResolvedValue({ connections: [] }),
    getNetworkErrors: vi.fn().mockResolvedValue({ errors: [] }),
    sampleGrid: vi.fn().mockResolvedValue({ grid: 3, width: 1280, height: 720 }),
    ...overrides,
  };
}

function planOrThrow<T>(plan: T | undefined): T {
  if (plan === undefined) throw new Error("expected mutation descriptor to return a plan");
  return plan;
}

describe("local copilot mutation verification", () => {
  it("passes exact create state and records bounded no-retry reads", async () => {
    const client = fakeClient();
    const plan = createMutationDescriptor().plan(
      {
        type: "noiseTOP",
        parameters: { period: 2 },
        placement: "explicit",
        node_x: 100,
        node_y: -50,
        viewer: true,
      },
      { node: { path: "/project1/noise1", parameter_warnings: [] } },
    );
    const report = await verifyMutation(client, planOrThrow(plan));

    expect(report.status).toBe("PASS");
    expect(report.mutationRetry).toBe("blocked");
    expect(report.limits.callsUsed).toBe(2);
    expect(client.getNode).toHaveBeenCalledWith("/project1/noise1", {
      timeoutMs: 800,
      retryGet: false,
    });
    expect(client.getNetworkErrors).toHaveBeenCalledWith("/project1", {
      timeoutMs: 800,
      retryGet: false,
    });
  });

  it("fails create and parameter updates when live state contradicts exact expectations", async () => {
    const client = fakeClient({
      getNode: vi.fn().mockResolvedValue({
        path: "/project1/noise1",
        type: "levelTOP",
        parameters: { period: 3 },
      }),
    });
    const createPlan = createMutationDescriptor().plan(
      { type: "noiseTOP", parameters: { period: 2 } },
      { node: { path: "/project1/noise1" } },
    );
    const updatePlan = updateParametersMutationDescriptor().plan(
      { path: "/project1/noise1", parameters: { period: 2 } },
      {},
    );

    expect((await verifyMutation(client, planOrThrow(createPlan))).status).toBe("FAIL");
    expect((await verifyMutation(client, planOrThrow(updatePlan))).status).toBe("FAIL");
  });

  it("proves delete only from a typed not-found response", async () => {
    const plan = deleteMutationDescriptor().plan(
      { path: "/project1/noise1" },
      {
        original_path: "/project1/noise1",
        final_path: null,
        action_applied: "delete",
        applied: true,
      },
    );
    const typedMissing = fakeClient({
      getNode: vi
        .fn()
        .mockRejectedValue(new TdApiError("missing", { status: 404, apiCode: "node_not_found" })),
    });
    const ambiguous = fakeClient({
      getNode: vi.fn().mockRejectedValue(new TdTimeoutError("late response")),
    });

    expect((await verifyMutation(typedMissing, planOrThrow(plan))).status).toBe("PASS");
    const unknown = await verifyMutation(ambiguous, planOrThrow(plan));
    expect(unknown.status).toBe("UNVERIFIED");
    expect(unknown.mutationRetry).toBe("blocked");
    expect(ambiguous.getNode).toHaveBeenCalledOnce();
  });

  it("does not treat a generic HTTP 404 or incomplete delete result as proof", async () => {
    const descriptor = deleteMutationDescriptor();
    expect(
      descriptor.plan(
        { path: "/project1/noise1" },
        { original_path: "/project1/noise1", final_path: null },
      ),
    ).toBeUndefined();

    const plan = planOrThrow(
      descriptor.plan(
        { path: "/project1/noise1" },
        {
          original_path: "/project1/noise1",
          final_path: null,
          action_applied: "delete",
          applied: true,
        },
      ),
    );
    const generic404 = fakeClient({
      getNode: vi.fn().mockRejectedValue(new TdApiError("route missing", { status: 404 })),
    });

    expect((await verifyMutation(generic404, plan)).status).toBe("UNVERIFIED");
  });

  it("distinguishes native Keep from a confirmed bypass", async () => {
    const keepPlan = deleteMutationDescriptor().plan(
      { path: "/project1/noise1" },
      {
        original_path: "/project1/noise1",
        final_path: "/project1/noise1",
        action_applied: "keep",
        applied: false,
      },
    );
    const bypassPlan = deleteMutationDescriptor().plan(
      { path: "/project1/noise1" },
      {
        original_path: "/project1/noise1",
        final_path: "/project1/noise1",
        action_applied: "bypass",
        applied: true,
      },
    );
    const keepClient = fakeClient({
      getNetworkErrors: vi.fn().mockResolvedValue({ errors: [{ message: "preexisting" }] }),
    });
    const bypassClient = fakeClient({
      getNode: vi.fn().mockResolvedValue({
        path: "/project1/noise1",
        flags: { bypass: true },
      }),
      getNetworkErrors: vi.fn().mockResolvedValue({ errors: [{ message: "preexisting" }] }),
    });

    const keep = await verifyMutation(keepClient, planOrThrow(keepPlan));
    const bypass = await verifyMutation(bypassClient, planOrThrow(bypassPlan));
    expect(keep.applied).toBe(false);
    expect(keep.status).toBe("PASS");
    expect(bypass.mutationKind).toBe("bypass");
    expect(bypass.status).toBe("PASS");
    expect(keepClient.getNetworkErrors).not.toHaveBeenCalled();
    expect(bypassClient.getNetworkErrors).not.toHaveBeenCalled();
  });

  it("rejects delete decisions whose structured applied flag is contradictory", () => {
    const descriptor = deleteMutationDescriptor();
    expect(
      descriptor.plan(
        { path: "/project1/noise1" },
        {
          original_path: "/project1/noise1",
          final_path: "/project1/noise1",
          action_applied: "keep",
          applied: true,
        },
      ),
    ).toBeUndefined();
    expect(
      descriptor.plan(
        { path: "/project1/noise1" },
        {
          original_path: "/project1/noise1",
          final_path: "/project1/noise1",
          action_applied: "bypass",
          applied: false,
        },
      ),
    ).toBeUndefined();
  });

  it("checks the actual packed connection slot and scoped errors", async () => {
    const plan = connectMutationDescriptor().plan(
      {
        source_path: "/project1/noise1",
        target_path: "/project1/comp1",
        source_output: 0,
        target_input: 2,
      },
      { actual_input: 1 },
    );
    const client = fakeClient({
      getNetworkTopology: vi.fn().mockResolvedValue({
        connections: [
          {
            source_path: "/project1/noise1",
            target_path: "/project1/comp1",
            source_output: 0,
            target_input: 1,
          },
        ],
      }),
    });

    expect((await verifyMutation(client, planOrThrow(plan))).status).toBe("PASS");
  });

  it("suppresses previews without grounded editor permission and samples only a confirmed TOP", async () => {
    const plan = generatorMutationDescriptor().plan(
      {},
      {
        container: "/project1/generated",
        created: ["/project1/generated/noise1", "/project1/generated/out1"],
        output: "/project1/generated/out1",
        errors: [],
      },
    );
    const client = fakeClient({
      getNode: vi.fn(async (path: string) => ({
        path,
        family: path.endsWith("out1") ? "TOP" : "COMP",
      })),
    });

    const suppressed = await verifyMutation(client, planOrThrow(plan), { allowPreview: false });
    expect(suppressed.preview).toBeUndefined();
    expect(client.sampleGrid).not.toHaveBeenCalled();

    const observed = await verifyMutation(client, planOrThrow(plan), { allowPreview: true });
    expect(observed.status).toBe("PASS");
    expect(observed.preview).toMatchObject({ status: "observed", grid: 3 });
    expect(client.sampleGrid).toHaveBeenCalledOnce();
  });

  it("treats reported or scoped cook errors as FAIL without aesthetic judgment", async () => {
    const reported = generatorMutationDescriptor().plan(
      {},
      {
        container: "/project1/generated",
        output: "/project1/generated/out1",
        errors: [{ path: "/project1/generated/noise1", message: "cook failed" }],
      },
    );
    const scoped = generatorMutationDescriptor().plan(
      {},
      {
        container: "/project1/generated",
        output: "/project1/generated/out1",
        errors: [],
      },
    );
    const client = fakeClient({
      getNode: vi.fn(async (path: string) => ({ path, family: "TOP" })),
      getNetworkErrors: vi.fn().mockResolvedValue({ errors: [{ message: "cook failed" }] }),
    });

    expect((await verifyMutation(client, planOrThrow(reported))).status).toBe("FAIL");
    expect((await verifyMutation(client, planOrThrow(scoped))).status).toBe("FAIL");
  });

  it("enforces the call/report bounds and observes cancellation during a read", async () => {
    const long = "x".repeat(500);
    const expectations = Array.from({ length: 16 }, (_, index) => ({
      type: "exists" as const,
      path: `/project1/${index}_${long}`,
    }));
    const bounded = await verifyMutation(fakeClient(), {
      kind: "generator",
      affectedPaths: Array.from({ length: 32 }, (_, index) => `/project1/${index}_${long}`),
      expectations,
      idempotency: "none",
      applied: true,
    });
    expect(bounded.limits.callsUsed).toBe(4);
    expect(bounded.status).toBe("UNVERIFIED");
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(16 * 1024);

    const controller = new AbortController();
    const pending = verifyMutation(
      fakeClient({ getNode: vi.fn(() => new Promise(() => {})) }),
      {
        kind: "update_parameters",
        affectedPaths: ["/project1/noise1"],
        expectations: [{ type: "exists", path: "/project1/noise1" }],
        idempotency: "reuse_exact",
        applied: true,
      },
      { signal: controller.signal },
    );
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.status).toBe("UNVERIFIED");
    expect(cancelled.checks[0]?.reason).toBe("cancelled");
  });
});
