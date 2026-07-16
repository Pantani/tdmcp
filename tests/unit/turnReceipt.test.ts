import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorGroundingEvidence } from "../../src/llm/editorGrounding.js";
import type { RecoveryReport } from "../../src/llm/failureRecovery.js";
import type { MutationVerificationReport } from "../../src/llm/mutationVerification.js";
import {
  createTurnReceiptCollector,
  fileTurnReceiptStore,
  readTurnReceiptStore,
  redactReceiptText,
  TURN_RECEIPT_MAX_BYTES,
  TURN_RECEIPT_STORE_MAX_AGE_MS,
  TURN_RECEIPT_STORE_MAX_BYTES,
  type TurnReceiptStoreAdapter,
  type TurnReceiptV1,
  TurnReceiptV1Schema,
} from "../../src/llm/turnReceipt.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempStore(name = "receipts.json"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tdmcp-turn-receipt-")));
  tempDirs.push(dir);
  return join(dir, name);
}

function grounding(performMode = false): EditorGroundingEvidence {
  return {
    schema_version: 1,
    status: "available",
    verification: performMode ? "UNVERIFIED" : "PASS",
    source: "touchdesigner_editor_context",
    freshness: { captured_at: "2026-07-15T12:00:00.000Z", max_age_ms: 1000 },
    reason: performMode ? "perform_mode" : "none",
    context: { perform_mode: performMode, ui_available: !performMode },
  };
}

function verification(status: "PASS" | "FAIL" | "UNVERIFIED"): MutationVerificationReport {
  return {
    status,
    mutationKind: "delete",
    affectedPaths: ["/project1/noise1"],
    applied: true,
    idempotency: "none",
    checks: [
      {
        expectation: "absent",
        path: "/project1/noise1",
        status,
        reason: "raw reason must not be persisted",
      },
    ],
    mutationRetry: "blocked",
    limits: { callsUsed: 1, maxCalls: 4, maxTotalMs: 3500, retryGet: false },
  };
}

const recovery: RecoveryReport = {
  category: "path_missing",
  action: "probe_exact_path",
  outcome: "recovered",
  budgetUsed: 1,
  mutationRetry: "blocked",
  evidence: { node: "raw evidence must not be persisted" },
};

function offReceipt(
  receiptId: string,
  completedAtMs = Date.parse("2026-07-15T12:00:00.000Z"),
): Promise<TurnReceiptV1> {
  const collector = createTurnReceiptCollector({
    requestedTier: "standard",
    effectiveTier: "safe",
    goalSummaryFromLatestUserMessage: "make a safe node",
    receiptId,
    now: () => completedAtMs,
  });
  return collector.finalize({ terminalStatus: "success" });
}

describe("turn receipt schema and collector", () => {
  it("projects only allowlisted typed evidence and redacts the genuine user goal", async () => {
    const emitted: TurnReceiptV1[] = [];
    const collector = createTurnReceiptCollector({
      requestedTier: "creative",
      effectiveTier: "standard",
      goalSummaryFromLatestUserMessage:
        "Delete it Authorization: Bearer abc.def api_key=super-secret " +
        "data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
      receiptId: "00000000-0000-4000-8000-000000000001",
      startedAt: new Date("2026-07-15T12:00:00.000Z"),
      now: () => Date.parse("2026-07-15T12:00:01.234Z"),
      onReceipt: (receipt) => {
        emitted.push(receipt);
      },
    });
    collector.recordGrounding(grounding());
    collector.recordToolOutcome(
      "delete_td_node",
      {
        ok: true,
        summary: "raw summary with secret=never-copy",
        payload: "raw payload with cookie=never-copy",
        structuredContent: {
          decision: "Overwrite",
          action_applied: "delete",
          final_path: "/project1/noise1",
          undo_label: "Delete noise1",
          unknown: "must not be copied",
        },
        affectedPaths: ["/project1/noise1", "relative/path"],
        verification: verification("PASS"),
        recovery,
      },
      "call-1",
    );

    const receipt = await collector.finalize({ terminalStatus: "success" });
    const serialized = JSON.stringify(receipt);

    expect(receipt).toMatchObject({
      receipt_id: "00000000-0000-4000-8000-000000000001",
      duration_ms: 1234,
      terminal_status: "success",
      requested_tier: "creative",
      effective_tier: "standard",
      grounding: { status: "available", verification: "PASS" },
      overall_verification: "PASS",
      persistence: "off",
    });
    expect(receipt.actions).toEqual([
      {
        tool: "delete_td_node",
        status: "success",
        affected_paths: ["/project1/noise1"],
        decision: "Overwrite",
        action_applied: "delete",
        undo_identity: "Delete noise1",
        verification: { status: "PASS", passed: 1, failed: 0, unverified: 0 },
        recovery: {
          category: "path_missing",
          action: "probe_exact_path",
          outcome: "recovered",
          budget_used: 1,
        },
      },
    ]);
    expect(serialized).not.toContain("abc.def");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("raw summary");
    expect(serialized).not.toContain("raw payload");
    expect(serialized).not.toContain("raw evidence");
    expect(serialized).not.toContain("must not be copied");
    expect(emitted).toEqual([receipt]);
    expect(TurnReceiptV1Schema.parse(receipt)).toEqual(receipt);
  });

  it("deduplicates calls, finalizes exactly once, and never lets recovery promote FAIL", async () => {
    const emit = vi.fn();
    const collector = createTurnReceiptCollector({
      requestedTier: "standard",
      effectiveTier: "standard",
      goalSummaryFromLatestUserMessage: "update it",
      onReceipt: emit,
    });
    const outcome = {
      ok: false,
      summary: "failure",
      payload: "failure payload",
      verification: verification("FAIL"),
      recovery,
    };
    collector.recordToolOutcome("update_td_node_parameters", outcome, "same-call");
    collector.recordToolOutcome("update_td_node_parameters", outcome, "same-call");

    const first = collector.finalize({ terminalStatus: "failed" });
    const second = collector.finalize({ terminalStatus: "success" });
    const [receiptA, receiptB] = await Promise.all([first, second]);

    expect(receiptA).toBe(receiptB);
    expect(receiptA.actions).toHaveLength(1);
    expect(receiptA.terminal_status).toBe("failed");
    expect(receiptA.overall_verification).toBe("FAIL");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it.each([
    "cancelled",
    "max_steps",
  ] as const)("emits exactly one receipt for the %s terminal path", async (terminalStatus) => {
    const emit = vi.fn();
    const collector = createTurnReceiptCollector({
      requestedTier: "chat",
      effectiveTier: "chat",
      goalSummaryFromLatestUserMessage: "chat only",
      onReceipt: emit,
    });
    const receipt = await collector.finalize({ terminalStatus });
    await collector.finalize({ terminalStatus: "success" });
    expect(receipt.terminal_status).toBe(terminalStatus);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("fails closed to a minimal action when typed evidence is malformed at runtime", async () => {
    const collector = createTurnReceiptCollector({
      requestedTier: "safe",
      effectiveTier: "safe",
      goalSummaryFromLatestUserMessage: "inspect safely",
    });
    collector.recordAction({
      tool: "bad tool name with spaces",
      status: "success",
      verification: { checks: "not-an-array" } as never,
      affectedPaths: ["/project1/safe"],
    });
    const receipt = await collector.finalize({ terminalStatus: "failed" });
    expect(receipt.actions).toEqual([
      { tool: "unknown_tool", status: "success", affected_paths: ["/project1/safe"] },
    ]);
    expect(receipt.warnings).toContain("receipt_action_projection_failed");
  });

  it("enforces redaction and the 8 KiB defense-in-depth cap", async () => {
    const collector = createTurnReceiptCollector({
      requestedTier: "creative",
      effectiveTier: "creative",
      goalSummaryFromLatestUserMessage: `secret=${"x".repeat(700)} ${"A".repeat(4000)}`,
    });
    for (let index = 0; index < 32; index += 1) {
      collector.recordAction({
        tool: `tool_${index}_${"x".repeat(100)}`,
        status: "success",
        affectedPaths: [`/project1/${"n".repeat(220)}${index}`],
        structuredContent: {
          undo_label: `checkpoint ${"u".repeat(150)}`,
          action_applied: "create",
        },
        verification: verification("PASS"),
        recovery,
      });
      collector.addWarning(`warning_${index}_${"w".repeat(220)}`);
    }
    const receipt = await collector.finalize({ terminalStatus: "success" });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(TURN_RECEIPT_MAX_BYTES);
    expect(receipt.actions.flatMap((action) => action.affected_paths).length).toBeGreaterThan(0);
    expect(receipt.actions.flatMap((action) => action.affected_paths).length).toBeLessThanOrEqual(
      16,
    );
    expect(JSON.stringify(receipt)).not.toContain("x".repeat(700));
    expect(TurnReceiptV1Schema.safeParse(receipt).success).toBe(true);
  });

  it("preserves the worst verification result when size compaction drops actions", async () => {
    const collector = createTurnReceiptCollector({
      requestedTier: "standard",
      effectiveTier: "standard",
      goalSummaryFromLatestUserMessage: "verify every mutation",
    });
    for (let index = 0; index < 31; index += 1) {
      collector.recordAction({
        tool: `pass_${index}_${"p".repeat(95)}`,
        status: "success",
        affectedPaths: [`/project1/${"n".repeat(180)}${index}`],
        structuredContent: { undo_label: `pass ${"u".repeat(140)}` },
        verification: verification("PASS"),
        recovery,
      });
    }
    collector.recordAction({
      tool: `last_fail_${"f".repeat(95)}`,
      status: "failed",
      verification: verification("FAIL"),
      recovery,
    });

    const receipt = await collector.finalize({ terminalStatus: "failed" });
    expect(receipt.overall_verification).toBe("FAIL");
    expect(receipt.actions.some((action) => action.verification?.status === "FAIL")).toBe(true);
    expect(receipt.warnings).toContain("receipt_compacted_preserving_worst_verification");
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(TURN_RECEIPT_MAX_BYTES);
  });

  it("redacts private keys, cookies and standalone base64 runs deterministically", () => {
    const input =
      "cookie=session-value\n-----BEGIN PRIVATE KEY-----\nsecret-body\n" +
      "-----END PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo1234567890==";
    const redacted = redactReceiptText(input);
    expect(redacted).toContain("cookie=[REDACTED]");
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
    expect(redacted).toContain("[REDACTED_BASE64]");
    expect(redacted).not.toContain("session-value");
    expect(redacted).not.toContain("secret-body");
  });

  it("redacts quoted JSON credential keys without preserving their values", () => {
    const redacted = redactReceiptText(
      '{"api_key":"super-secret-value","password":"hunter2-value","cookie":"session-secret-value","refresh_token":"refresh-secret-value","auth_token":"auth-secret-value","token":"generic-secret-value"}',
    );
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain("hunter2-value");
    expect(redacted).not.toContain("session-secret-value");
    expect(redacted).not.toContain("refresh-secret-value");
    expect(redacted).not.toContain("auth-secret-value");
    expect(redacted).not.toContain("generic-secret-value");
  });
});

describe("turn receipt persistence", () => {
  it.each([
    { name: "off by default", options: {}, expected: "off" },
    {
      name: "explicit noPersist",
      options: { persistence: "persist" as const, noPersist: true },
      expected: "off",
    },
  ])("skips storage when $name", async ({ options, expected }) => {
    const store: TurnReceiptStoreAdapter = { write: vi.fn(async () => "written" as const) };
    const collector = createTurnReceiptCollector({
      requestedTier: "safe",
      effectiveTier: "safe",
      goalSummaryFromLatestUserMessage: "inspect",
      store,
      ...options,
    });
    const receipt = await collector.finalize({ terminalStatus: "success" });
    expect(receipt.persistence).toBe(expected);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("skips awaited disk I/O in perform mode and for every emergency alias", async () => {
    for (const tool of [
      undefined,
      "panic",
      "trigger_blackout",
      "emergency.stop",
      "e-stop",
      "fail_safe",
      "kill_switch",
      "master_kill",
      "stop_all",
      "all_stop",
    ]) {
      const store: TurnReceiptStoreAdapter = { write: vi.fn(async () => "written" as const) };
      const collector = createTurnReceiptCollector({
        requestedTier: "standard",
        effectiveTier: "standard",
        goalSummaryFromLatestUserMessage: "show action",
        persistence: "persist",
        storePath: tempStore(`${tool ?? "perform"}.json`),
        store,
      });
      if (tool) collector.recordAction({ tool, status: "success" });
      else collector.recordGrounding(grounding(true));
      const receipt = await collector.finalize({ terminalStatus: "success" });
      expect(receipt.persistence).toBe(tool ? "emergency" : "show_mode");
      expect(store.write).not.toHaveBeenCalled();
    }
  });

  it("writes private atomic stores and preserves concurrent receipts", async () => {
    const path = tempStore();
    const first = await offReceipt("00000000-0000-4000-8000-000000000011");
    const second = await offReceipt(
      "00000000-0000-4000-8000-000000000012",
      Date.parse("2026-07-15T12:00:01.000Z"),
    );

    expect(
      await Promise.all([
        fileTurnReceiptStore.write(path, first),
        fileTurnReceiptStore.write(path, second),
      ]),
    ).toEqual(["written", "written"]);

    const loaded = readTurnReceiptStore(path);
    expect(loaded.state).toBe("available");
    if (loaded.state !== "available") throw new Error("receipt store was not readable");
    expect(new Set(loaded.store.receipts.map((receipt) => receipt.receipt_id))).toEqual(
      new Set([first.receipt_id, second.receipt_id]),
    );
    if (process.platform !== "win32") expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("payload");
  });

  it("persists an opted-in collector receipt as written", async () => {
    const path = tempStore();
    const collector = createTurnReceiptCollector({
      requestedTier: "standard",
      effectiveTier: "safe",
      goalSummaryFromLatestUserMessage: "persist the bounded audit",
      persistence: "persist",
      storePath: path,
    });
    const receipt = await collector.finalize({ terminalStatus: "success" });
    expect(receipt.persistence).toBe("written");
    const loaded = readTurnReceiptStore(path);
    expect(loaded.state).toBe("available");
    if (loaded.state === "available") {
      expect(loaded.store.receipts.map((entry) => entry.receipt_id)).toContain(receipt.receipt_id);
    }
  });

  it("prunes persisted receipts by age, count and total bytes", async () => {
    const path = tempStore();
    const now = Date.now();
    const old = await offReceipt(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      now - TURN_RECEIPT_STORE_MAX_AGE_MS - 1,
    );
    expect(await fileTurnReceiptStore.write(path, old)).toBe("written");
    for (let index = 0; index < 101; index += 1) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const item = await offReceipt(id, now - index * 1000);
      expect(await fileTurnReceiptStore.write(path, item)).toBe("written");
    }
    const loaded = readTurnReceiptStore(path);
    expect(loaded.state).toBe("available");
    if (loaded.state !== "available") throw new Error("receipt store was not readable");
    expect(loaded.store.receipts).toHaveLength(100);
    expect(loaded.store.receipts.map((item) => item.receipt_id)).not.toContain(old.receipt_id);
    expect(lstatSync(path).size).toBeLessThanOrEqual(TURN_RECEIPT_STORE_MAX_BYTES);
  });

  it("marks store failures without changing the terminal result", async () => {
    const store: TurnReceiptStoreAdapter = {
      write: vi.fn(async () => {
        throw new Error("disk unavailable with private details");
      }),
    };
    const collector = createTurnReceiptCollector({
      requestedTier: "safe",
      effectiveTier: "safe",
      goalSummaryFromLatestUserMessage: "save receipt",
      persistence: "persist",
      storePath: tempStore(),
      store,
    });
    const receipt = await collector.finalize({ terminalStatus: "success" });
    expect(receipt.terminal_status).toBe("success");
    expect(receipt.persistence).toBe("failed");
    expect(receipt.warnings).toContain("receipt_persistence_failed");
    expect(JSON.stringify(receipt)).not.toContain("private details");
  });

  it("rejects corrupt, non-private and symlink stores without following them", async () => {
    const candidate = await offReceipt("00000000-0000-4000-8000-000000000031");
    const corrupt = tempStore("corrupt.json");
    writeFileSync(corrupt, "not-json", { mode: 0o600 });
    expect(readTurnReceiptStore(corrupt).state).toBe("invalid");
    expect(await fileTurnReceiptStore.write(corrupt, candidate)).toBe("failed");
    expect(readFileSync(corrupt, "utf8")).toBe("not-json");

    const nonPrivate = tempStore("public.json");
    writeFileSync(nonPrivate, JSON.stringify({ schema_version: 1, receipts: [] }), { mode: 0o600 });
    chmodSync(nonPrivate, 0o666);
    expect(readTurnReceiptStore(nonPrivate).state).toBe("invalid");

    const target = tempStore("target.json");
    writeFileSync(target, JSON.stringify({ schema_version: 1, receipts: [] }), { mode: 0o600 });
    const link = tempStore("link.json");
    symlinkSync(target, link);
    expect(readTurnReceiptStore(link).state).toBe("invalid");
    expect(await fileTurnReceiptStore.write(link, candidate)).toBe("failed");
  });

  it("rejects a receipt path whose parent chain contains a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "tdmcp-turn-receipt-parent-link-"));
    tempDirs.push(root);
    const realParent = join(root, "real-parent");
    mkdirSync(realParent, { mode: 0o700 });
    const linkedParent = join(root, "linked-parent");
    symlinkSync(realParent, linkedParent);
    const path = join(linkedParent, "receipts.json");
    const candidate = await offReceipt("00000000-0000-4000-8000-000000000041");

    expect(await fileTurnReceiptStore.write(path, candidate)).toBe("failed");
    expect(existsSync(join(realParent, "receipts.json"))).toBe(false);
  });
});
