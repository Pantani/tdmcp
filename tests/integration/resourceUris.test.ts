import { afterAll, describe, expect, it } from "vitest";
import { closeSessions, connectClient, jsonText, type ResourceClientSession } from "./helpers.js";

const sessions: ResourceClientSession[] = [];
afterAll(() => closeSessions(sessions));

// RFC 3986: unreserved / reserved / percent-encoded. A space (or any other
// character outside this set) makes `format: uri` fail in strict clients.
const URI_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const PCT = /%(?![0-9A-Fa-f]{2})/;

const SPACED_PYTHON_CLASSES = [
  "Error DAT",
  "OP Viewer COMP",
  "Pattern CHOP",
  "Replicator COMP",
  "td Module",
];

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

    // Python API data must be present, or the checks above prove nothing for it.
    const uris = resources.map((r) => r.uri);
    for (const className of SPACED_PYTHON_CLASSES) {
      const uri = `tdmcp://python-api/${encodeURIComponent(className)}`;
      expect(uris).toContain(uri);
      const result = await session.client.readResource({ uri });
      expect(JSON.parse(jsonText(result))).toMatchObject({ className });
    }
  }, 60_000);

  it("does not read files outside the python-api data", async () => {
    const session = await connectClient("tdmcp-uri-traversal-test");
    sessions.push(session);
    const uri = "tdmcp://python-api/..%2F..%2F..%2F..%2Fpackage";
    const body = JSON.parse(jsonText(await session.client.readResource({ uri })));
    expect(body).toEqual({ error: expect.stringContaining("not found") });
  });
});
