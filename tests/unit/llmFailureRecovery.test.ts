import { describe, expect, it, vi } from "vitest";
import {
  classifyFailure,
  type FailureCategory,
  recoverFailure,
} from "../../src/llm/failureRecovery.js";
import { TdApiError, TdConnectionError, TdTimeoutError } from "../../src/td-client/types.js";

function fakeClient() {
  return {
    getInfo: vi.fn().mockResolvedValue({ build: "2025.32820", bridge_version: "0.13.1" }),
    getNetworkTopology: vi.fn().mockResolvedValue({
      nodes: [{ path: "/project1/moved/noise1", name: "noise1", type: "noiseTOP" }],
    }),
    getParameterMenu: vi.fn().mockResolvedValue({ names: ["add", "multiply"] }),
  };
}

const STOP_CATEGORIES = [
  "timeout_ambiguous",
  "verification_failed",
  "auth_or_policy",
  "unknown",
] satisfies FailureCategory[];

describe("local copilot adaptive failure recovery", () => {
  it("classifies every typed category with an unknown fallback", () => {
    const cases = [
      [{ phase: "parse" as const, mutates: false }, "bad_json"],
      [{ phase: "validate" as const, mutates: false }, "invalid_args"],
      [
        { phase: "dispatch" as const, mutates: false, error: new TdConnectionError("offline") },
        "bridge_offline",
      ],
      [{ phase: "dispatch" as const, mutates: false, apiCode: "heartbeat_stale" }, "bridge_stale"],
      [
        { phase: "dispatch" as const, mutates: true, error: new TdTimeoutError("late") },
        "timeout_ambiguous",
      ],
      [{ phase: "dispatch" as const, mutates: false, status: 403 }, "auth_or_policy"],
      [
        {
          phase: "dispatch" as const,
          mutates: false,
          error: new TdApiError("missing", { apiCode: "node_not_found" }),
        },
        "path_missing",
      ],
      [
        { phase: "dispatch" as const, mutates: false, apiCode: "invalid_menu_value" },
        "menu_invalid",
      ],
      [
        { phase: "verify" as const, mutates: true, verificationStatus: "FAIL" as const },
        "verification_failed",
      ],
      [{ phase: "dispatch" as const, mutates: false, error: new Error("no code") }, "unknown"],
    ] as const;

    for (const [input, expected] of cases) {
      expect(classifyFailure(input).category).toBe(expected);
    }
  });

  it("does not classify a generic HTTP 404 as a missing TD path", () => {
    expect(
      classifyFailure({
        phase: "dispatch",
        mutates: false,
        error: new TdApiError("route missing", { status: 404 }),
      }).category,
    ).toBe("unknown");
  });

  it("returns bounded validation evidence without a TD call or guessed rewrite", async () => {
    const client = fakeClient();
    const failure = classifyFailure({ phase: "validate", mutates: true });
    const report = await recoverFailure(client, failure, {
      mutates: true,
      validationIssues: Array.from({ length: 20 }, (_, index) => ({
        path: `/parameters/${index}`,
        code: "invalid_type",
        message: "x".repeat(500),
      })),
    });

    expect(report).toMatchObject({
      action: "return_validation_evidence",
      outcome: "recovered",
      budgetUsed: 1,
      mutationRetry: "blocked",
    });
    expect(report.evidence?.issues as unknown[]).toHaveLength(12);
    expect(JSON.stringify(report.evidence).length).toBeLessThanOrEqual(8 * 1024);
    expect(client.getInfo).not.toHaveBeenCalled();
    expect(client.getNetworkTopology).not.toHaveBeenCalled();
  });

  it("allows one no-retry bridge probe only for a read failure", async () => {
    const client = fakeClient();
    const readFailure = classifyFailure({
      phase: "dispatch",
      mutates: false,
      error: new TdConnectionError("offline"),
    });
    const mutationFailure = classifyFailure({
      phase: "dispatch",
      mutates: true,
      error: new TdConnectionError("offline"),
    });

    const recovered = await recoverFailure(client, readFailure, { mutates: false });
    const stopped = await recoverFailure(client, mutationFailure, { mutates: true });
    expect(recovered).toMatchObject({
      action: "probe_bridge",
      outcome: "recovered",
      budgetUsed: 1,
    });
    expect(client.getInfo).toHaveBeenCalledWith({ timeoutMs: 1000, retryGet: false });
    expect(stopped).toMatchObject({ outcome: "stopped", mutationRetry: "blocked" });
    expect(client.getInfo).toHaveBeenCalledOnce();
  });

  it("finds but never substitutes one exact moved basename", async () => {
    const client = fakeClient();
    const failure = classifyFailure({
      phase: "dispatch",
      mutates: false,
      apiCode: "node_not_found",
    });
    const report = await recoverFailure(client, failure, {
      mutates: false,
      affectedPaths: ["/project1/moved/noise1"],
      searchRoot: "/project1",
    });

    expect(report).toMatchObject({
      action: "probe_exact_path",
      outcome: "recovered",
      mutationRetry: "blocked",
    });
    expect(client.getNetworkTopology).toHaveBeenCalledWith("/project1", true, {
      timeoutMs: 1000,
      retryGet: false,
    });
  });

  it("reports live menu choices as evidence but never executes a correction", async () => {
    const client = fakeClient();
    const failure = classifyFailure({
      phase: "dispatch",
      mutates: false,
      apiCode: "invalid_menu_value",
    });
    const report = await recoverFailure(client, failure, {
      mutates: false,
      affectedPaths: ["/project1/comp1"],
      parameter: "operation",
    });

    expect(report).toMatchObject({
      action: "probe_menu",
      outcome: "recovered",
      evidence: { choices: ["add", "multiply"] },
      mutationRetry: "blocked",
    });
    expect(client.getParameterMenu).toHaveBeenCalledOnce();
  });

  it.each(STOP_CATEGORIES)("stops %s without a retry or evidence probe", async (category) => {
    const client = fakeClient();
    const failure = {
      category,
      phase: category === "verification_failed" ? "verify" : "dispatch",
      ambiguous: category === "timeout_ambiguous",
      safeMessage: "bounded",
    } as const;
    const report = await recoverFailure(client, failure, {
      mutates: true,
      affectedPaths: ["/project1/noise1"],
    });
    expect(report).toMatchObject({ outcome: "stopped", mutationRetry: "blocked" });
    expect(client.getInfo).not.toHaveBeenCalled();
    expect(client.getNetworkTopology).not.toHaveBeenCalled();
  });

  it("honors a spent recovery budget", async () => {
    const client = fakeClient();
    const failure = classifyFailure({ phase: "validate", mutates: false });
    const report = await recoverFailure(client, failure, { mutates: false, budget: 0 });
    expect(report).toMatchObject({ action: "stop", budgetUsed: 0, outcome: "stopped" });
  });

  it("stops a probe when cancellation arrives after it starts", async () => {
    const controller = new AbortController();
    const client = {
      ...fakeClient(),
      getInfo: vi.fn(() => new Promise<Record<string, unknown>>(() => {})),
    };
    const pending = recoverFailure(
      client,
      classifyFailure({
        phase: "dispatch",
        mutates: false,
        error: new TdConnectionError("offline"),
      }),
      { mutates: false, signal: controller.signal },
    );
    controller.abort();

    expect(await pending).toMatchObject({
      action: "probe_bridge",
      outcome: "stopped",
      budgetUsed: 1,
      mutationRetry: "blocked",
    });
  });
});
