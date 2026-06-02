# Doctor Fix Textport Auto Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tdmcp-agent doctor --fix` attempt a bounded macOS TouchDesigner Textport install before falling back to the manual Textport command.

**Architecture:** Keep `install-bridge` as the source of truth for copying bridge modules and generating the install command. Return a structured result from `runInstallBridge`, then let `doctor --fix` run a test-injectable auto runner that can paste/execute that command in TouchDesigner and verify `/api/info`.

**Tech Stack:** TypeScript, Node child_process, Vitest/MSW, existing `runDoctor` and `runInstallBridge` CLI helpers.

---

### Task 1: Structured Install Bridge Result

**Files:**
- Modify: `src/cli/installBridge.ts`
- Test: `tests/unit/installBridge.test.ts`

- [x] **Step 1: Write failing tests**

```ts
it("returns the no-preferences Textport command for callers", async () => {
  const fetchImpl = vi.fn();
  vi.stubGlobal("fetch", fetchImpl);

  const result = await runInstallBridge(["--dir", "/tmp/tdmcp-bridge"]);

  expect(result?.ok).toBe(true);
  expect(result?.modulesDir).toBe("/tmp/tdmcp-bridge/modules");
  expect(result?.textportCommand).toBe(
    "from mcp import install; install.run()",
  );
  expect(result?.noPrefsTextportCommand).toBe(
    'import sys; sys.path.insert(0, "/tmp/tdmcp-bridge/modules")\nfrom mcp import install; install.run(modules_dir="/tmp/tdmcp-bridge/modules")',
  );
});
```

- [x] **Step 2: Verify red**

Run: `npm test -- tests/unit/installBridge.test.ts`

Expected: FAIL because `runInstallBridge` currently returns `void`.

- [x] **Step 3: Implement minimal result**

Add an exported `InstallBridgeResult` and return it from success/failure branches. Preserve console output and `process.exitCode`.

- [x] **Step 4: Verify green**

Run: `npm test -- tests/unit/installBridge.test.ts`

Expected: PASS.

### Task 2: Doctor Auto Textport Runner

**Files:**
- Modify: `src/cli/doctor.ts`
- Test: `tests/unit/doctor-fix.test.ts`

- [x] **Step 1: Write failing tests**

```ts
it("--fix attempts Textport auto-install when install-bridge cannot verify immediately", async () => {
  server.use(offlineInfoHandler, llmModels("qwen2.5:3b"));
  const attempted: string[] = [];
  const r = await runDoctor({
    config: makeConfig(),
    makeCtx,
    fix: true,
    runInstallBridge: async () => ({
      ok: false,
      detail: "manual Textport step required",
      noPrefsTextportCommand:
        'import sys; sys.path.insert(0, "/tmp/tdmcp-bridge/modules")\nfrom mcp import install; install.run(modules_dir="/tmp/tdmcp-bridge/modules")',
    }),
    runTextportInstall: async (command) => {
      attempted.push(command);
      return { ok: true, detail: "Textport command sent" };
    },
  });

  expect(attempted).toHaveLength(1);
  expect(r.report.repairs).toContainEqual(
    expect.objectContaining({ id: "bridge", status: "applied" }),
  );
});
```

- [x] **Step 2: Verify red**

Run: `npm test -- tests/unit/doctor-fix.test.ts`

Expected: FAIL because `runTextportInstall` does not exist yet.

- [x] **Step 3: Implement minimal doctor auto runner**

Add `runTextportInstall?: (command: string) => Promise<{ ok: boolean; detail: string }>` to `RunDoctorOptions`. In `repairBridge`, when `install-bridge --verify` returns `ok:false` with `noPrefsTextportCommand` or `textportCommand`, call the runner once. Treat runner success as an applied bridge repair and runner failure as a failed repair that includes the manual fallback command.

- [x] **Step 4: Implement default macOS runner**

Use `osascript` only on `darwin`; otherwise return a clear unsupported result. The script should activate TouchDesigner, open Textport with `Option-T`, paste the exact command, press Return, and remain bounded by `TDMCP_TEXTPORT_INSTALL_TIMEOUT_MS`.

- [x] **Step 5: Verify green**

Run: `npm test -- tests/unit/doctor-fix.test.ts`

Expected: PASS.

### Task 3: Docs and Full Verification

**Files:**
- Modify: `docs/ROADMAP.md`
- Modify: `docs/guide/prompt-cookbook.md`
- Modify: `docs/pt/guide/prompt-cookbook.md`

- [x] **Step 1: Update docs**

Mention that `doctor --fix` now attempts a macOS Textport auto-install when the bridge is offline and keeps the manual command as fallback.

- [x] **Step 2: Run focused checks**

Run: `npm test -- tests/unit/installBridge.test.ts tests/unit/doctor-fix.test.ts`

Expected: PASS.

- [x] **Step 3: Run wider checks**

Run: `npm run typecheck`

Expected: PASS.
