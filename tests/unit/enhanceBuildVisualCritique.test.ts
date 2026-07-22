import { describe, expect, it, vi } from "vitest";
import {
  deriveVisualOverall,
  parseVisualProposal,
  runBoundedVisualCritique,
  VISUAL_CRITIQUE_FIXTURE_SUITE,
  VISUAL_CRITIQUE_RUBRIC_ID,
  type VisualApprovalResult,
  type VisualCommitRequest,
  type VisualCommitResult,
  type VisualCritiqueArgs,
  type VisualCritiqueDependencies,
  type VisualInspection,
  type VisualModelResponse,
  type VisualPreviewEvidence,
  validateVisualCritiqueContext,
  visualCritiqueSchema,
} from "../../src/tools/layer1/enhanceBuildVisualCritique.js";

const NOW = Date.UTC(2026, 6, 15, 18, 0, 0);
const MODEL = "qwen3-vl:8b-instruct-q4_K_M";
const DIGEST = "0533d74300e4f9bc367d675d4e64ffd073d50ff16a2b4096cc2e8a1cf8c96319";
const FINGERPRINT = "sha256:c7439a25964685329e256ee9706aba340226068cbc5a652f802eef30d0ed1241";

function args(overrides: Partial<VisualCritiqueArgs> = {}): VisualCritiqueArgs {
  return visualCritiqueSchema.parse({
    outputTopPath: "/project1/show/out1",
    targets: [
      {
        nodePath: "/project1/look/grade1",
        parameter: "saturation",
        minimum: 0,
        maximum: 2,
      },
    ],
    idempotencyKey: "artist-request-0001",
    ...overrides,
  });
}

function gate() {
  return {
    identity: {
      provider: "ollama",
      model: MODEL,
      digest: DIGEST,
      quantization: "Q4_K_M",
      fingerprint: FINGERPRINT,
      advertisesVision: true,
    },
    calibration: {
      status: "PASS" as const,
      model: MODEL,
      digest: DIGEST,
      fingerprint: FINGERPRINT,
      reusableForMutation: true,
      expiresAtMs: NOW + 60_000,
      imageInput: { status: "PASS" as const, passed: 1, failed: 0, unverified: 0 },
    },
    fixture: {
      result: "PASS" as const,
      suite: VISUAL_CRITIQUE_FIXTURE_SUITE,
      rubricId: VISUAL_CRITIQUE_RUBRIC_ID,
      model: MODEL,
      digest: DIGEST,
      calibrationFingerprint: FINGERPRINT,
      strictResponses: 6,
      goodSpread: 0,
      badSpread: 0,
      medianDelta: 39,
      expiresAtMs: NOW + 60_000,
    },
  };
}

function inspection(value = 0.8, fingerprint = "snapshot-a"): VisualInspection {
  return {
    scopePath: "/project1",
    outputTopPath: "/project1/show/out1",
    fingerprint,
    targets: [
      {
        id: "t1",
        path: "/project1/look/grade1",
        parameter: "saturation",
        type: "Float",
        mode: "CONSTANT",
        value,
        minimum: 0,
        maximum: 2,
      },
    ],
  };
}

function proposal(
  value = 0.92,
  scores: readonly [number, number, number, number] = [85, 90, 95, 80],
) {
  return JSON.stringify({
    rubric: {
      composition_hierarchy: scores[0],
      palette_coherence: scores[1],
      contrast_legibility: scores[2],
      spatial_balance: scores[3],
    },
    summary: "Model prose must not be persisted.",
    changes: [
      {
        target_id: "t1",
        value,
        rationale: "Model rationale must not be persisted.",
        risk: "low",
      },
    ],
  });
}

function verification(scores: readonly [number, number, number, number] = [90, 90, 90, 90]) {
  return JSON.stringify({
    rubric: {
      composition_hierarchy: scores[0],
      palette_coherence: scores[1],
      contrast_legibility: scores[2],
      spatial_balance: scores[3],
    },
    summary: "Verification prose must not be persisted.",
    changes: [],
  });
}

function modelResponse(text: string): VisualModelResponse {
  return {
    text,
    identity: { model: MODEL, digest: DIGEST, fingerprint: FINGERPRINT },
  };
}

function dependencies(overrides: Partial<VisualCritiqueDependencies> = {}) {
  const commitResult = {
    status: "committed" as const,
    applied: true as const,
    verified: true as const,
    finalFingerprint: "snapshot-b",
    restoreToken: "restore-opaque",
    readback: [{ targetId: "t1", value: 0.92 }],
    undoLabel: "MCP enhance_build visual parameters /project1",
  };
  const deps: VisualCritiqueDependencies = {
    now: () => NOW,
    resolveGate: vi.fn(async () => gate()),
    inspect: vi.fn(async () => inspection()),
    capture: vi.fn(async () => ({
      base64: Buffer.from("bounded-image-bytes").toString("base64"),
      mimeType: "image/png" as const,
      width: 640 as const,
      height: 360 as const,
      technical: { errorCount: 0, perfScore: 90, previewReadable: true },
    })),
    critique: vi
      .fn()
      .mockResolvedValueOnce(modelResponse(proposal()))
      .mockResolvedValueOnce(modelResponse(verification())),
    approve: vi.fn(
      async (): Promise<VisualApprovalResult> => ({
        requestId: "interaction-1",
        state: "resolved",
        choice: "Apply",
      }),
    ),
    commit: vi.fn(async (): Promise<VisualCommitResult> => commitResult),
    restore: vi.fn(async () => ({
      restored: true,
      verified: true,
      restoredFingerprint: "snapshot-a",
      undoLabel: "MCP restore enhance_build visual parameters /project1",
    })),
    ...overrides,
  };
  return deps;
}

function run(
  deps: VisualCritiqueDependencies,
  input: {
    autoApply?: boolean;
    visualCritique?: VisualCritiqueArgs;
    focusCriterion?: string;
    signal?: AbortSignal;
  } = {},
) {
  return runBoundedVisualCritique(
    {
      scopePath: "/project1",
      autoApply: input.autoApply ?? false,
      visualCritique: input.visualCritique ?? args(),
      ...(input.focusCriterion ? { focusCriterion: input.focusCriterion } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    deps,
  );
}

describe("enhance_build bounded visual critique core", () => {
  it("enforces the strict bounded input schema and scope collision rules", () => {
    expect(() => visualCritiqueSchema.parse({ ...args(), unexpected: true })).toThrow();
    expect(() =>
      visualCritiqueSchema.parse({
        ...args(),
        targets: [args().targets[0], args().targets[0]],
      }),
    ).toThrow(/unique/);
    expect(() =>
      visualCritiqueSchema.parse({ ...args(), outputTopPath: "/project1/../secret" }),
    ).toThrow(/traversal/);
    expect(() => visualCritiqueSchema.parse({ ...args(), maxIterations: 3 })).toThrow();
    expect(() => visualCritiqueSchema.parse({ ...args(), maxChanges: 4 })).toThrow();
    expect(() => visualCritiqueSchema.parse({ ...args(), confirmationTimeoutMs: 4_999 })).toThrow();
    expect(validateVisualCritiqueContext("/project1", "palette", args())).toContain(
      "focusCriterion cannot be combined with visualCritique",
    );
    expect(
      validateVisualCritiqueContext(
        "/project1",
        undefined,
        args({ outputTopPath: "/outside/out1" }),
      ),
    ).toContain("outputTopPath escapes scopePath");
  });

  it("accepts fences only, rejects trailing prose and model-supplied overall", () => {
    expect(parseVisualProposal(`\`\`\`json\n${proposal()}\n\`\`\``).changes).toHaveLength(1);
    expect(() => parseVisualProposal(`${proposal()} trailing prose`)).toThrow();
    const withOverall = JSON.parse(proposal()) as Record<string, unknown>;
    withOverall.overall = 99;
    expect(() => parseVisualProposal(JSON.stringify(withOverall))).toThrow();
    expect(
      deriveVisualOverall({
        composition_hierarchy: 85,
        palette_coherence: 90,
        contrast_legibility: 95,
        spatial_balance: 80,
      }),
    ).toBe(88);
  });

  it("fails closed before inspection when exact calibration or TD fixture identity drifts", async () => {
    const mismatched = gate();
    mismatched.fixture.calibrationFingerprint = "sha256:different";
    const deps = dependencies({ resolveGate: vi.fn(async () => mismatched) });
    const result = await run(deps);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.warnings.join(" ")).toMatch(/fixture receipt/);
    expect(deps.inspect).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("fails closed when the completion identity differs from the gated digest", async () => {
    const response = modelResponse(proposal());
    response.identity.digest = "different-runtime-digest";
    const deps = dependencies({ critique: vi.fn(async () => response) });
    const result = await run(deps);
    expect(result.status).toBe("FAIL");
    expect(result.warnings.join(" ")).toMatch(/strict contract/);
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("keeps legacy-safe preview semantics: proposal PASS, no approval or mutation", async () => {
    const requests: unknown[] = [];
    const deps = dependencies({
      critique: vi.fn(async (request) => {
        requests.push(request);
        return modelResponse(proposal());
      }),
    });
    const result = await run(deps);
    expect(result.status).toBe("PASS");
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]?.before.visual_score).toBe(88);
    expect(deps.approve).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
    const serializedRequest = JSON.stringify(requests[0]);
    expect(serializedRequest).not.toContain("/project1");
    expect(serializedRequest).not.toContain("saturation");
    const serializedReceipt = JSON.stringify(result);
    expect(serializedReceipt).not.toContain("bounded-image-bytes");
    expect(serializedReceipt).not.toContain("Model prose");
    expect(serializedReceipt).not.toContain("Model rationale");
  });

  it("treats explicit native Keep as PASS and never commits", async () => {
    const deps = dependencies({
      approve: vi.fn(
        async (): Promise<VisualApprovalResult> => ({
          requestId: "interaction-keep",
          state: "resolved",
          choice: "Keep",
        }),
      ),
    });
    const result = await run(deps, { autoApply: true });
    expect(result.status).toBe("PASS");
    expect(result.iterations[0]?.decision).toEqual({
      state: "resolved",
      choice: "Keep",
      request_id: "interaction-keep",
    });
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it.each([
    "pending",
    "expired",
    "cancelled",
    "failed",
  ] as const)("maps native %s to Keep + UNVERIFIED with no commit", async (state) => {
    const deps = dependencies({
      approve: vi.fn(async (): Promise<VisualApprovalResult> => ({ state, choice: "Apply" })),
    });
    const result = await run(deps, { autoApply: true });
    expect(result.status).toBe("UNVERIFIED");
    expect(result.iterations[0]?.decision?.choice).toBe("Keep");
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it("requires explicit Apply, then verifies exact CAS readback and after evidence", async () => {
    const commits: VisualCommitRequest[] = [];
    const deps = dependencies({
      commit: vi.fn(async (request): Promise<VisualCommitResult> => {
        commits.push(request);
        return {
          status: "committed",
          applied: true,
          verified: true,
          finalFingerprint: "snapshot-b",
          restoreToken: "restore-opaque",
          readback: [{ targetId: "t1", value: 0.92 }],
        };
      }),
    });
    const result = await run(deps, { autoApply: true });
    expect(result.status).toBe("PASS");
    expect(result.iterations[0]?.apply).toMatchObject({ applied: true, verified: true });
    expect(result.iterations[0]?.after?.visual_score).toBe(90);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.expectedFingerprint).toBe("snapshot-a");
    expect(commits[0]?.changes).toEqual([{ targetId: "t1", value: 0.92 }]);
    expect(commits[0]?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it("replays one ambiguous response with the identical idempotency payload", async () => {
    const requests: VisualCommitRequest[] = [];
    const commit = vi.fn(async (request: VisualCommitRequest): Promise<VisualCommitResult> => {
      requests.push(request);
      throw new Error("response lost");
    });
    commit.mockImplementationOnce(async (request): Promise<VisualCommitResult> => {
      requests.push(request);
      throw new Error("response lost");
    });
    commit.mockImplementationOnce(async (request): Promise<VisualCommitResult> => {
      requests.push(request);
      return {
        status: "committed",
        applied: true,
        verified: true,
        finalFingerprint: "snapshot-b",
        restoreToken: "restore-opaque",
        readback: [{ targetId: "t1", value: 0.92 }],
      };
    });
    const deps = dependencies({ commit });
    const result = await run(deps, { autoApply: true });
    expect(result.status).toBe("PASS");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it("returns UNVERIFIED without after evidence when commit CAS reports stale targets", async () => {
    const deps = dependencies({
      commit: vi.fn(async (): Promise<VisualCommitResult> => ({ status: "conflict" })),
    });
    const result = await run(deps, { autoApply: true });
    expect(result.status).toBe("UNVERIFIED");
    expect(result.iterations[0]?.apply).toEqual({ applied: false, verified: false });
    expect(deps.capture).toHaveBeenCalledTimes(1);
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it("rejects duplicate, out-of-bounds and non-integer proposals before approval", async () => {
    const duplicate = JSON.parse(proposal()) as { changes: unknown[] };
    duplicate.changes.push({
      target_id: "t1",
      value: 1.1,
      rationale: "again",
      risk: "low",
    });
    const duplicateDeps = dependencies({
      critique: vi.fn(async () => modelResponse(JSON.stringify(duplicate))),
    });
    expect((await run(duplicateDeps, { autoApply: true })).status).toBe("FAIL");
    expect(duplicateDeps.approve).not.toHaveBeenCalled();

    const boundedDeps = dependencies({
      critique: vi.fn(async () => modelResponse(proposal(3))),
    });
    expect((await run(boundedDeps, { autoApply: true })).status).toBe("FAIL");
    expect(boundedDeps.approve).not.toHaveBeenCalled();

    const intDeps = dependencies({
      inspect: vi.fn(async () => {
        const current = inspection(1);
        const target = current.targets[0];
        if (!target) throw new Error("test fixture target missing");
        return {
          ...current,
          targets: [{ ...target, type: "Int" as const, value: 1 }],
        };
      }),
      critique: vi.fn(async () => modelResponse(proposal(1.5))),
    });
    expect((await run(intDeps, { autoApply: true })).status).toBe("FAIL");
    expect(intDeps.approve).not.toHaveBeenCalled();
  });

  it("restores exactly once on visual regression and reports FAIL even after verified restore", async () => {
    const deps = dependencies({
      critique: vi
        .fn()
        .mockResolvedValueOnce(modelResponse(proposal()))
        .mockResolvedValueOnce(modelResponse(verification([10, 10, 10, 10]))),
    });
    const result = await run(deps, { autoApply: true });
    expect(result.status).toBe("FAIL");
    expect(result.iterations[0]?.rollback).toMatchObject({
      attempted: true,
      restored: true,
      verified: true,
      reason: "regression",
    });
    expect(deps.restore).toHaveBeenCalledTimes(1);
  });

  it("restores after missing after-evidence and exposes rollback failure honestly", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({
        base64: Buffer.from("before").toString("base64"),
        mimeType: "image/png",
        width: 640,
        height: 360,
        technical: { errorCount: 0, perfScore: 90, previewReadable: true },
      })
      .mockRejectedValueOnce(new Error("after capture failed"));
    const deps = dependencies({
      capture,
      restore: vi.fn(async () => ({ restored: false, verified: false, reason: "artist_edit" })),
    });
    const result = await run(deps, { autoApply: true });
    expect(result.status).toBe("FAIL");
    expect(result.iterations[0]?.rollback).toMatchObject({
      attempted: true,
      restored: false,
      verified: false,
      reason: "artist_edit",
    });
    expect(result.warnings).toContain("rollback_failed");
  });

  it("uses a fresh gate, inspection, approval and idempotency identity for each of two iterations", async () => {
    let inspectCount = 0;
    const commits: VisualCommitRequest[] = [];
    const deps = dependencies({
      inspect: vi.fn(async () => {
        inspectCount += 1;
        return inspection(inspectCount === 1 ? 0.8 : 0.92, `snapshot-${inspectCount}`);
      }),
      critique: vi
        .fn()
        .mockResolvedValueOnce(modelResponse(proposal(0.92)))
        .mockResolvedValueOnce(modelResponse(verification()))
        .mockResolvedValueOnce(modelResponse(proposal(1.02)))
        .mockResolvedValueOnce(modelResponse(verification())),
      approve: vi.fn(
        async (): Promise<VisualApprovalResult> => ({
          requestId: `interaction-${inspectCount}`,
          state: "resolved",
          choice: "Apply",
        }),
      ),
      commit: vi.fn(async (request): Promise<VisualCommitResult> => {
        commits.push(request);
        const second = commits.length === 2;
        return {
          status: "committed",
          applied: true,
          verified: true,
          finalFingerprint: second ? "snapshot-3" : "snapshot-2",
          restoreToken: second ? "restore-2" : "restore-1",
          readback: [{ targetId: "t1", value: second ? 1.02 : 0.92 }],
        };
      }),
    });
    const result = await run(deps, {
      autoApply: true,
      visualCritique: args({ maxIterations: 2 }),
    });
    expect(result.status).toBe("PASS");
    expect(result.iterations).toHaveLength(2);
    expect(deps.resolveGate).toHaveBeenCalledTimes(2);
    expect(deps.approve).toHaveBeenCalledTimes(2);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.idempotencyKey).not.toBe(commits[1]?.idempotencyKey);
  });

  it("does not pass an already-aborted signal into verification or compensating restore", async () => {
    const controller = new AbortController();
    let captures = 0;
    const deps = dependencies({
      commit: vi.fn(async (): Promise<VisualCommitResult> => {
        controller.abort();
        return {
          status: "committed",
          applied: true,
          verified: true,
          finalFingerprint: "snapshot-b",
          restoreToken: "restore-opaque",
          readback: [{ targetId: "t1", value: 0.92 }],
        };
      }),
      capture: vi.fn(async (request): Promise<VisualPreviewEvidence> => {
        captures += 1;
        if (captures === 2) {
          expect(request.signal).toBeUndefined();
          throw new Error("after capture failed");
        }
        return {
          base64: Buffer.from("before").toString("base64"),
          mimeType: "image/png",
          width: 640,
          height: 360,
          technical: { errorCount: 0, perfScore: 90, previewReadable: true },
        };
      }),
      restore: vi.fn(async (request) => {
        expect(request.signal).toBeUndefined();
        return { restored: true, verified: true, restoredFingerprint: "snapshot-a" };
      }),
    });
    const result = await run(deps, { autoApply: true, signal: controller.signal });
    expect(result.status).toBe("FAIL");
    expect(deps.restore).toHaveBeenCalledTimes(1);
  });

  it("rejects approval details that cannot fit without truncation", async () => {
    const long = `/project1/${"very_long_component_name_".repeat(7)}`.slice(0, 230);
    const visualCritique = args({
      outputTopPath: `${long}/out1`.slice(0, 240),
      targets: [
        {
          nodePath: `${long}/grade1`.slice(0, 240),
          parameter: "saturation",
          minimum: 0,
          maximum: 2,
        },
      ],
    });
    const deps = dependencies({
      inspect: vi.fn(async () => {
        const target = inspection().targets[0];
        const requested = visualCritique.targets[0];
        if (!target || !requested) throw new Error("test fixture target missing");
        return {
          scopePath: "/project1",
          outputTopPath: visualCritique.outputTopPath,
          fingerprint: "snapshot-long",
          targets: [{ ...target, path: requested.nodePath }],
        };
      }),
    });
    const result = await run(deps, { autoApply: true, visualCritique });
    expect(result.status).toBe("FAIL");
    expect(result.warnings.join(" ")).toMatch(/512/);
    expect(deps.approve).not.toHaveBeenCalled();
  });
});
