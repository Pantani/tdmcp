import { describe, expect, it } from "vitest";
import { TDMCP_SERVER_INSTRUCTIONS } from "../../src/server/tdmcpServer.js";

describe("MCP server editor-context instructions", () => {
  it("guides external hosts without claiming invisible conversation grounding", () => {
    expect(TDMCP_SERVER_INSTRUCTIONS).toContain("call get_editor_context first");
    expect(TDMCP_SERVER_INSTRUCTIONS).toContain('"this node"');
    expect(TDMCP_SERVER_INSTRUCTIONS).toContain("selected node");
    expect(TDMCP_SERVER_INSTRUCTIONS).toContain("place it here");
    expect(TDMCP_SERVER_INSTRUCTIONS).toContain("ask for an explicit path");
    expect(TDMCP_SERVER_INSTRUCTIONS).toContain("tdmcp://project/brief");
    expect(TDMCP_SERVER_INSTRUCTIONS).toContain("tdmcp://session/receipts");
    expect(TDMCP_SERVER_INSTRUCTIONS).toContain("do not receive project context");
    expect(TDMCP_SERVER_INSTRUCTIONS).not.toContain("automatically inject");
  });
});
