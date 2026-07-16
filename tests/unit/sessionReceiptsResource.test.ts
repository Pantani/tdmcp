import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTurnReceiptCollector,
  fileTurnReceiptStore,
  type TurnReceiptV1,
} from "../../src/llm/turnReceipt.js";
import {
  readSessionReceipts,
  registerSessionReceiptsResource,
} from "../../src/resources/sessionReceipts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempStore(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tdmcp-session-receipts-")));
  tempDirs.push(dir);
  return join(dir, "receipts.json");
}

async function receipt(
  id: string,
  terminalStatus: "success" | "failed",
  completedAt: string,
): Promise<TurnReceiptV1> {
  const collector = createTurnReceiptCollector({
    requestedTier: "standard",
    effectiveTier: "safe",
    goalSummaryFromLatestUserMessage: "bounded goal",
    receiptId: id,
    now: () => Date.parse(completedAt),
  });
  return collector.finalize({ terminalStatus });
}

describe("session receipts resource", () => {
  it("returns typed off and missing states without exposing a filesystem path", () => {
    const path = tempStore();
    const uri = new URL("tdmcp://session/receipts?limit=5");

    const off = readSessionReceipts(uri, {
      env: { TDMCP_COPILOT_RECEIPTS_PATH: path },
    });
    const missing = readSessionReceipts(uri, {
      env: { TDMCP_COPILOT_RECEIPTS: "persist", TDMCP_COPILOT_RECEIPTS_PATH: path },
    });

    expect(off).toMatchObject({ state: "off", count: 0, receipts: [] });
    expect(missing).toMatchObject({ state: "missing", count: 0, receipts: [] });
    expect(JSON.stringify([off, missing])).not.toContain(path);
  });

  it("filters newest-first by bounded limit and terminal status", async () => {
    const path = tempStore();
    const first = await receipt(
      "00000000-0000-4000-8000-000000000021",
      "success",
      "2026-07-15T12:00:00.000Z",
    );
    const second = await receipt(
      "00000000-0000-4000-8000-000000000022",
      "failed",
      "2026-07-15T12:00:01.000Z",
    );
    const third = await receipt(
      "00000000-0000-4000-8000-000000000023",
      "success",
      "2026-07-15T12:00:02.000Z",
    );
    for (const item of [first, second, third]) {
      expect(await fileTurnReceiptStore.write(path, item)).toBe("written");
    }

    const result = readSessionReceipts(new URL("tdmcp://session/receipts?limit=1&status=success"), {
      env: { TDMCP_COPILOT_RECEIPTS: "persist", TDMCP_COPILOT_RECEIPTS_PATH: path },
      now: Date.parse("2026-07-15T12:00:03.000Z"),
    });

    expect(result.state).toBe("available");
    expect(result.count).toBe(1);
    expect(result.receipts.map((item) => item.receipt_id)).toEqual([third.receipt_id]);
    expect(result.filters).toEqual({ limit: 1, status: "success" });
  });

  it("honors effective config values without requiring process env parity", async () => {
    const path = tempStore();
    const item = await receipt(
      "00000000-0000-4000-8000-000000000099",
      "success",
      "2026-07-15T12:00:00.000Z",
    );
    expect(await fileTurnReceiptStore.write(path, item)).toBe("written");
    const result = readSessionReceipts(new URL("tdmcp://session/receipts?limit=1"), {
      env: {},
      persistence: "persist",
      storePath: path,
      now: Date.parse("2026-07-15T12:00:01.000Z"),
    });
    expect(result.state).toBe("available");
    expect(result.receipts.map((entry) => entry.receipt_id)).toEqual([item.receipt_id]);
  });

  it("returns invalid for malformed queries, relative overrides, corrupt modes and symlinks", () => {
    const path = tempStore();
    const env = { TDMCP_COPILOT_RECEIPTS: "persist", TDMCP_COPILOT_RECEIPTS_PATH: path };
    expect(readSessionReceipts(new URL("tdmcp://session/receipts?limit=0"), { env }).state).toBe(
      "invalid",
    );
    expect(
      readSessionReceipts(new URL("tdmcp://session/receipts?status=other"), { env }).state,
    ).toBe("invalid");
    expect(readSessionReceipts(new URL("tdmcp://session/receipts?path=/tmp"), { env }).state).toBe(
      "invalid",
    );
    expect(
      readSessionReceipts(new URL("tdmcp://session/receipts"), {
        env: { TDMCP_COPILOT_RECEIPTS: "persist", TDMCP_COPILOT_RECEIPTS_PATH: "relative.json" },
      }).state,
    ).toBe("invalid");

    writeFileSync(path, JSON.stringify({ schema_version: 1, receipts: [] }), { mode: 0o600 });
    chmodSync(path, 0o666);
    expect(readSessionReceipts(new URL("tdmcp://session/receipts"), { env }).state).toBe("invalid");

    const target = tempStore();
    writeFileSync(target, JSON.stringify({ schema_version: 1, receipts: [] }), { mode: 0o600 });
    const link = join(target, "..", "receipt-link.json");
    symlinkSync(target, link);
    expect(
      readSessionReceipts(new URL("tdmcp://session/receipts"), {
        env: { TDMCP_COPILOT_RECEIPTS: "persist", TDMCP_COPILOT_RECEIPTS_PATH: link },
      }).state,
    ).toBe("invalid");
  });

  it("registers the exact read-only URI template and emits JSON", async () => {
    const calls: Array<{
      name: string;
      template: ResourceTemplate;
      metadata: { mimeType?: string };
      handler: (uri: URL) => Promise<{ contents: Array<{ text?: string }> }>;
    }> = [];
    const server = {
      registerResource(
        name: string,
        template: ResourceTemplate,
        metadata: { mimeType?: string },
        handler: (uri: URL) => Promise<{ contents: Array<{ text?: string }> }>,
      ) {
        calls.push({ name, template, metadata, handler });
      },
    };

    registerSessionReceiptsResource(server as never, {} as never);
    const registered = calls[0];
    if (!registered) throw new Error("resource was not registered");
    expect(registered.name).toBe("td-session-receipts");
    expect(registered.template.uriTemplate.toString()).toBe(
      "tdmcp://session/receipts{?limit,status}",
    );
    expect(registered.metadata.mimeType).toBe("application/json");
    const result = await registered.handler(new URL("tdmcp://session/receipts"));
    expect(JSON.parse(result.contents[0]?.text ?? "{}")).toMatchObject({ state: "off" });
  });
});
