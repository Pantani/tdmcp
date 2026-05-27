import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { buildRenderScript, renderOutputImpl } from "../../src/tools/layer3/renderOutput.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  node: string;
  file: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a script");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("buildRenderScript", () => {
  it("embeds the node path and output file in the payload", () => {
    const script = buildRenderScript({ node: "/project1/render1", file: "/tmp/frame.png" });
    const payload = decodePayload(script);
    expect(payload.node).toBe("/project1/render1");
    expect(payload.file).toBe("/tmp/frame.png");
  });
});

describe("renderOutputImpl", () => {
  it("reports the saved path and native dimensions on success", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ saved: "/tmp/frame.png", width: 1920, height: 1080 }),
    }));
    const result = await renderOutputImpl(fakeCtx(exec), {
      node_path: "/project1/render1",
      file: "/tmp/frame.png",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/tmp/frame.png");
    expect(text).toContain("1920");
    expect(text).toContain("1080");
    // The payload was forwarded correctly.
    expect(decodePayload(scriptArg(exec)).node).toBe("/project1/render1");
  });

  it("returns an error result when the TD report carries a fatal", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ fatal: "Node not found: /project1/missing" }),
    }));
    const result = await renderOutputImpl(fakeCtx(exec), {
      node_path: "/project1/missing",
      file: "/tmp/frame.png",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Node not found");
  });
});
