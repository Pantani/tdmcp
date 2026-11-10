import { afterAll, describe, expect, it } from "vitest";
import { closeSessions, connectClient, type ResourceClientSession } from "./helpers.js";

const sessions: ResourceClientSession[] = [];
afterAll(() => closeSessions(sessions));

// RFC 3986: unreserved / reserved / percent-encoded. A space (or any other
// character outside this set) makes `format: uri` fail in strict clients.
const URI_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const PCT = /%(?![0-9A-Fa-f]{2})/;

describe("integration: resource URIs", () => {
  it("lists only RFC 3986-valid URIs that read back", async () => {
    const session = await connectClient("tdmcp-uri-test");
    sessions.push(session);
    const { resources } = await session.client.listResources();
    expect(resources.length).toBeGreaterThan(0);

    const invalid = resources
      .map((r) => r.uri)
      .filter((uri) => !URI_CHARS.test(uri) || PCT.test(uri));
    expect(invalid).toEqual([]);

    const failures: string[] = [];
    for (const { uri } of resources) {
      const result = await session.client.readResource({ uri });
      const first = result.contents[0];
      const text = first && "text" in first ? first.text : "";
      if (/"error":\s*".*not found/i.test(text)) failures.push(uri);
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
