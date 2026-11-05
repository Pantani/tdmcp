import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  freeLoopbackPort,
  listenOnLoopback,
  startOnFreeLoopbackPort,
} from "../helpers/loopbackPort.js";

function addressInUse(): NodeJS.ErrnoException {
  return Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
}

describe("loopback port helpers", () => {
  it("binds to an OS-assigned port and reports it", async () => {
    const server = createServer();
    const port = await listenOnLoopback(server);
    try {
      expect(port).toBeGreaterThan(0);
      expect(server.address()).toMatchObject({ address: "127.0.0.1", port });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects immediately when the port is taken instead of hanging", async () => {
    const holder = createServer();
    const port = await listenOnLoopback(holder);
    try {
      await expect(listenOnLoopback(createServer(), port)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it("returns a port that can be bound", async () => {
    const port = await freeLoopbackPort();
    const server = createServer();
    await expect(listenOnLoopback(server, port)).resolves.toBe(port);
    await new Promise((resolve) => server.close(resolve));
  });

  it("retries on EADDRINUSE and returns the port that worked", async () => {
    const start = vi
      .fn<(port: number) => Promise<string>>()
      .mockRejectedValueOnce(addressInUse())
      .mockResolvedValueOnce("started");
    const result = await startOnFreeLoopbackPort(start);
    expect(start).toHaveBeenCalledTimes(2);
    expect(result.value).toBe("started");
    expect(result.port).toBe(start.mock.calls[1]?.[0]);
  });

  it("gives up after the last attempt with the bind error", async () => {
    const start = vi.fn<(port: number) => Promise<string>>().mockRejectedValue(addressInUse());
    await expect(startOnFreeLoopbackPort(start, 3)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("does not retry other startup failures", async () => {
    const start = vi.fn<(port: number) => Promise<string>>().mockRejectedValue(new Error("bad"));
    await expect(startOnFreeLoopbackPort(start)).rejects.toThrow("bad");
    expect(start).toHaveBeenCalledTimes(1);
  });
});
