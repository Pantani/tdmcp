import type { Server } from "node:net";
import { createServer } from "node:net";

const LOOPBACK = "127.0.0.1";

/**
 * Bind `server` to loopback and return the port it got. Port 0 (the default)
 * asks the OS for a free one. A bind failure rejects at once, so it reports as
 * itself instead of a hook timeout.
 */
export function listenOnLoopback(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
      else reject(new Error("server has no TCP address after listening"));
    });
  });
}

/** Ask the OS for a loopback port that is free right now. */
export async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  const port = await listenOnLoopback(probe);
  await new Promise<void>((resolve, reject) => {
    probe.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

function isAddressInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "EADDRINUSE";
}

/**
 * Start something that must know its port before it binds, such as the HTTP
 * transport: its config rejects port 0 and its OAuth issuer and Host allowlist
 * are built from the configured port. The port can be taken between the probe
 * closing and `start` binding, so EADDRINUSE retries on a new port. Any other
 * failure is rethrown unchanged.
 */
export async function startOnFreeLoopbackPort<T>(
  start: (port: number) => Promise<T>,
  attempts = 5,
): Promise<{ port: number; value: T }> {
  for (let attempt = 1; ; attempt += 1) {
    const port = await freeLoopbackPort();
    try {
      return { port, value: await start(port) };
    } catch (err) {
      if (attempt >= attempts || !isAddressInUse(err)) throw err;
    }
  }
}
