import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SourceSkippedError } from "../../../src/creativeRag/sources/errors.js";
import { smithsonianSource } from "../../../src/creativeRag/sources/smithsonian.js";

const SMITHSONIAN_SEARCH = "https://api.si.edu/openaccess/api/v1.0/search";

const SMITHSONIAN_RESPONSE = {
  response: {
    rows: [
      {
        content: {
          descriptiveNonRepeating: {
            title: { content: "Apollo 11 Command Module" },
            record_link: "https://www.si.edu/object/apollo11",
            online_media: {
              media: [
                {
                  type: "Images",
                  usage: { access: "CC0" },
                  content: "https://ids.si.edu/ids/deliveryService?id=apollo11",
                  thumbnail: "https://ids.si.edu/ids/thumb?id=apollo11",
                },
              ],
            },
          },
          freetext: { name: [{ content: "NASA" }] },
        },
      },
      {
        content: {
          descriptiveNonRepeating: {
            title: { content: "Rights-Restricted Object" },
            record_link: "https://www.si.edu/object/restricted",
            online_media: {
              media: [
                {
                  type: "Images",
                  usage: { access: "Restricted" },
                  content: "https://ids.si.edu/ids/deliveryService?id=restricted",
                },
              ],
            },
          },
          freetext: { name: [{ content: "Unknown Maker" }] },
        },
      },
      // No record_link — sourceUrl must be built from record_ID (a bare
      // edanmdm identifier), not emitted raw.
      {
        content: {
          descriptiveNonRepeating: {
            title: { content: "Record-ID Only Object" },
            record_ID: "edanmdm-nmah_1234567",
            guid: "http://n2t.net/ark:/65665/abcdef",
            online_media: {
              media: [{ type: "Images", usage: { access: "CC0" } }],
            },
          },
        },
      },
      // Malformed — no title, must be skipped.
      {
        content: {
          descriptiveNonRepeating: {
            record_link: "https://www.si.edu/object/untitled",
          },
        },
      },
    ],
  },
};

const server = setupServer(
  http.get(SMITHSONIAN_SEARCH, () => HttpResponse.json(SMITHSONIAN_RESPONSE)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

describe("smithsonianSource", () => {
  it("maps CC0 items (with image) and classifies restricted ones as Unknown when keyed", async () => {
    vi.stubEnv("TDMCP_RAG_SMITHSONIAN_KEY", "test-key");

    const items = await smithsonianSource.fetchItems(5, fetch);
    expect(items).toHaveLength(3); // malformed item skipped

    const cc0 = items.find((i) => i.title === "Apollo 11 Command Module");
    expect(cc0?.license).toBe("CC0");
    expect(cc0?.artist).toBe("NASA");
    expect(cc0?.sourceUrl).toBe("https://www.si.edu/object/apollo11");
    expect(cc0?.imageUrl).toBe("https://ids.si.edu/ids/deliveryService?id=apollo11");

    // No record_link ⇒ sourceUrl is the canonical object page built from record_ID.
    const byId = items.find((i) => i.title === "Record-ID Only Object");
    expect(byId?.sourceUrl).toBe("https://www.si.edu/object/edanmdm-nmah_1234567");

    // Restricted ⇒ Unknown and no imageUrl, even though an image exists.
    const restricted = items.find((i) => i.title === "Rights-Restricted Object");
    expect(restricted?.license).toBe("Unknown");
    expect(restricted?.imageUrl).toBeUndefined();
  });

  it("throws SourceSkippedError (not an empty sync) and does NOT call fetch when the env key is absent", async () => {
    vi.stubEnv("TDMCP_RAG_SMITHSONIAN_KEY", "");
    const fetchSpy = vi.fn();

    // A missing key must NOT resolve to [] — that would let service.sync tombstone
    // every existing Smithsonian card. It is a skipped source, surfaced as a throw.
    await expect(
      smithsonianSource.fetchItems(5, fetchSpy as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(SourceSkippedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("suppresses imageUrl when the allowlist is empty even for CC0", async () => {
    vi.stubEnv("TDMCP_RAG_SMITHSONIAN_KEY", "test-key");

    const items = await smithsonianSource.fetchItems(5, fetch, []);
    const cc0 = items.find((i) => i.title === "Apollo 11 Command Module");
    expect(cc0?.license).toBe("CC0");
    expect(cc0?.imageUrl).toBeUndefined();
  });
});
