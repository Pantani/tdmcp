import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse } from "msw";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type {
  ExternalShowScaffoldPayload,
  ExternalShowScaffoldReport,
} from "../../src/tools/layer2/externalShowBridgeScaffold.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { TD_BASE } from "../helpers/tdMock.js";

export function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

export function parseJsonFence(result: CallToolResult): ExternalShowScaffoldReport {
  const match = /```json\n([\s\S]+?)\n```/.exec(textOf(result));
  if (!match?.[1]) throw new Error("no JSON fence in result");
  return JSON.parse(match[1]) as ExternalShowScaffoldReport;
}

export function decodePayload(script: string): ExternalShowScaffoldPayload {
  const encoded = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (encoded === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as ExternalShowScaffoldPayload;
}

export function execOk(report: ExternalShowScaffoldReport) {
  return HttpResponse.json({
    ok: true,
    data: { result: null, stdout: JSON.stringify(report) },
  });
}
