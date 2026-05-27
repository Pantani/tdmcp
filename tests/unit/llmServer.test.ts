import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startChatServer } from "../../src/llm/server.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { TdmcpConfig } from "../../src/utils/config.js";

/** Grab a free loopback port so the test never collides with a real chat server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** GET / with explicit Host/Origin headers, returning only the status code. */
function getRoot(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("startChatServer loopback guard", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    port = await freePort();
    const config = {
      chatPort: port,
      llmBaseUrl: "http://127.0.0.1:11434",
      llmModel: "test",
      llmApiKey: undefined,
    } as unknown as TdmcpConfig;
    const handle = await startChatServer({} as unknown as ToolContext, config);
    close = handle.close;
  });
  afterAll(() => close?.());

  it("allows a loopback Host with no Origin", async () => {
    expect(await getRoot(port, { Host: `127.0.0.1:${port}` })).toBe(200);
  });

  it("allows the localhost Host alias", async () => {
    expect(await getRoot(port, { Host: `localhost:${port}` })).toBe(200);
  });

  it("allows a same-origin loopback Origin", async () => {
    expect(
      await getRoot(port, { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }),
    ).toBe(200);
  });

  it("rejects a rebound non-loopback Host (DNS rebinding)", async () => {
    expect(await getRoot(port, { Host: "evil.example.com" })).toBe(403);
  });

  it("rejects a cross-origin Origin (CSRF)", async () => {
    expect(
      await getRoot(port, { Host: `127.0.0.1:${port}`, Origin: "http://evil.example.com" }),
    ).toBe(403);
  });
});
